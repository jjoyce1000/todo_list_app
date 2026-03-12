/**
 * PDF to tasks parser for API.
 * Uses pdf-parse for text extraction, optionally OpenAI for interpretation.
 */
const { PDFParse } = require('pdf-parse');
const auth = require('./auth');

let OpenAI;
try {
  const openai = require('openai');
  OpenAI = openai.OpenAI || openai.default || openai;
} catch {
  OpenAI = null;
}

const PDF_AI_MODEL = process.env.PDF_AI_MODEL || 'gpt-4o';

/**
 * Extract text from PDF buffer.
 */
async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    await parser.destroy();
    return result?.text || '';
  } catch (e) {
    try { await parser.destroy(); } catch (_) {}
    throw e;
  }
}

/**
 * Parse PDF content with OpenAI when OPENAI_API_KEY is set.
 */
async function parseWithAi(text, filename) {
  if (!OpenAI || !process.env.OPENAI_API_KEY) return null;

  const content = `Filename: ${filename || 'document.pdf'}\n\n--- Extracted Text ---\n${(text || '').slice(0, 90000)}`;

  const prompt = `Extract all tasks, assignments, due dates, exams, readings, and schedule entries from this syllabus/schedule PDF.
Return a JSON object with a "tasks" array. Each task must have:
- "task": short description (e.g. "Homework 1", "Exam 2", "Read Ch. 5")
- "date": YYYY-MM-DD format, or empty string if no date
- "course": course name/code (e.g. M156, Physics 111) or "General"

Rules:
- Infer year from document (Fall 2026, Spring 2026, etc.) when dates lack year
- One item per task; split "HW 1, 2, 3" into separate tasks if dates differ
- Skip headers, column labels, and meta text (e.g. "Week", "Monday", "Date")
- Use the course name from the document title or header
- Dates: prefer ISO YYYY-MM-DD; empty string if unknown

Example output: {"tasks": [{"task": "Homework 1 due", "date": "2026-01-15", "course": "M156"}, ...]}`;

  try {
    const client = new OpenAI();
    const resp = await client.chat.completions.create({
      model: PDF_AI_MODEL,
      messages: [
        { role: 'system', content: 'You extract structured task data from syllabi and schedules. Respond only with valid JSON.' },
        { role: 'user', content: `${prompt}\n\n${content}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });
    const raw = resp.choices[0]?.message?.content;
    if (!raw) return null;
    const data = JSON.parse(raw);
    const tasks = data.tasks;
    if (!Array.isArray(tasks)) return null;
    return tasks.map((t) => ({
      id: auth.genId(),
      text: String(t.task || '').trim(),
      dueDate: String(t.date || '').trim(),
      courseId: '',
      category: String(t.course || 'General').trim() || 'General',
      done: false,
      parentId: '',
    })).filter((t) => t.text.length > 0);
  } catch {
    return null;
  }
}

/**
 * Simple regex-based fallback when OpenAI is not available.
 */
function parseWithRegex(text, filename) {
  const items = [];
  const yearHint = extractYearHint(text, filename);
  const course = extractCourse(text, filename);

  const dateRe = /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?/gi;
  const dueRe = /(?:due|exam|deadline)\s*(?:by|date)?\s*[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?)/gi;

  const noise = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'week', 'topic', 'date', 'readings', 'assessment', 'homework due', 'lab']);
  const seen = new Set();

  function normDate(s) {
    if (!s || !s.trim()) return '';
    const m = s.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if (m) {
      let [, mo, d, y] = m;
      y = parseInt(y, 10);
      if (y < 100) y = y < 50 ? 2000 + y : 1900 + y;
      if (y < 2024) y = yearHint;
      mo = parseInt(mo, 10);
      d = parseInt(d, 10);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const monthRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i;
    const mm = s.match(monthRe);
    if (mm) {
      const y = mm[3] ? parseInt(mm[3], 10) : yearHint;
      try {
        const dt = new Date(`${mm[1]} ${mm[2]} ${y}`);
        if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
      } catch (_) {}
    }
    return '';
  }

  let currentDate = '';
  const lines = (text || '').split(/\r?\n/).filter((l) => l.trim());

  for (const line of lines) {
    dueRe.lastIndex = 0;
    dateRe.lastIndex = 0;
    const dueMatch = dueRe.exec(line);
    if (dueMatch) currentDate = normDate(dueMatch[1]) || currentDate;
    const dateMatch = dateRe.exec(line);
    if (dateMatch) currentDate = normDate(dateMatch[0]) || currentDate;

    let taskPart = line.replace(dateRe, '').replace(dueRe, '').replace(/\s+/g, ' ').trim();
    taskPart = taskPart.replace(/^(?:readings?|topic|assessment|homework|lab)\s*[:\-]\s*/i, '');
    if (!taskPart || taskPart.length < 2) continue;
    const tl = taskPart.toLowerCase();
    if (noise.has(tl) || tl.startsWith('http') || /^page\s+\d+$/i.test(taskPart)) continue;
    const key = `${tl}|${currentDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: auth.genId(),
      text: taskPart,
      dueDate: currentDate,
      courseId: '',
      category: course,
      done: false,
      parentId: '',
    });
  }
  return items;
}

function extractYearHint(text, filename) {
  const currentYear = new Date().getFullYear();
  const header = ((text || '') + ' ' + (filename || '')).slice(0, 1200);
  const m = header.match(/(?:Fall|Spring|Summer|Winter|Academic\s+Year)\s+(20\d{2})/i) ||
    header.match(/(20\d{2})[-–]\s*(20\d{2})/) ||
    header.match(/\b(20\d{2})\b/);
  if (m) {
    const y = parseInt(m[1] || m[2] || m[0], 10);
    if (y >= 1990 && y <= currentYear + 2) return y;
  }
  return currentYear;
}

function extractCourse(text, filename) {
  const first = ((text || '') + ' ' + (filename || '')).slice(0, 1200);
  const m = first.match(/(?:course|syllabus)\s*(?:title|name|number)?\s*[:\-]\s*([^\n]{3,80})/i) ||
    first.match(/(?:Physics|PHYS|Math|MATH|M\d{2,4}|CS|History|HIST|ENG|BIO)\s*\d{2,4}[A-Z]?/i) ||
    first.match(/[A-Z]{2,6}\s*\d{3}[A-Z]?/);
  if (m) return m[1]?.trim() || m[0]?.trim() || 'General';
  const fn = (filename || '').replace(/Copy of | - Sheet1/gi, '');
  const fm = fn.match(/(Physics\s*111|M\d{2,4}|MATH\s*\d{2,4}|[A-Z]{2,6}\s*\d{3})/i);
  if (fm) return fm[1].trim();
  return 'General';
}

/**
 * Parse PDF buffer into tasks.
 * @param {Buffer} buffer - PDF file buffer
 * @param {string} filename - Original filename for hints
 * @returns {Promise<Array>} Array of task objects
 */
async function parsePdfToTasks(buffer, filename = 'document.pdf') {
  const text = await extractPdfText(buffer);
  if (!text || text.trim().length < 10) {
    throw new Error('Could not extract text from PDF or PDF appears empty.');
  }

  let tasks = await parseWithAi(text, filename);
  if (!tasks || tasks.length === 0) {
    tasks = parseWithRegex(text, filename);
  }
  if (!tasks || tasks.length === 0) {
    throw new Error('No tasks found in PDF.');
  }
  return tasks;
}

module.exports = { parsePdfToTasks, extractPdfText };
