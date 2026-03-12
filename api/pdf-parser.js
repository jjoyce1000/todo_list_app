/**
 * PDF to tasks parser for API.
 * Uses pdf-parse for text extraction, optionally Claude Sonnet 4.6 for interpretation.
 */
const { PDFParse } = require('pdf-parse');
const auth = require('./auth');

let Anthropic;
try {
  ({ Anthropic } = require('@anthropic-ai/sdk'));
} catch {
  Anthropic = null;
}

// Anthropic API uses "claude-sonnet-4-6"; "anthropic.claude-sonnet-4-6" is AWS Bedrock format
function getPdfAiModel() {
  const raw = (process.env.PDF_AI_MODEL || 'claude-sonnet-4-6').trim();
  return raw.startsWith('anthropic.') ? raw.slice(10) : raw;
}

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

function hasAnthropicKey() {
  const key = (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '').trim();
  return key.length > 0;
}

/**
 * Parse PDF content with Claude Sonnet 4.6 when ANTHROPIC_API_KEY is set.
 */
async function parseWithAi(text, filename) {
  if (!Anthropic || !hasAnthropicKey()) return null;

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
- Include ALL weeks from the start: calendar grids often have Mon–Fri columns; the first date in each row is Monday (e.g. 1/12). Do NOT skip Week 1 or the first week's content. Assign content to the correct date column (e.g. Monday 1/12, Tuesday 1/13, etc.)

Example output: {"tasks": [{"task": "Homework 1 due", "date": "2026-01-15", "course": "M156"}, ...]}`;

  try {
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: getPdfAiModel(),
      max_tokens: 4096,
      system: 'You extract structured task data from syllabi and schedules. Respond only with valid JSON.',
      messages: [{ role: 'user', content: `${prompt}\n\n${content}` }],
      temperature: 0.1,
    });
    const usage = resp.usage;
    if (usage) {
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      console.log(`[PDF AI] tokens: input=${input} output=${output} total=${total}`);
    }
    const textBlock = resp.content?.find((b) => b.type === 'text');
    let raw = textBlock?.text;
    if (!raw) return null;
    raw = raw.trim();
    // Strip markdown code blocks (```json ... ``` or ``` ... ```)
    raw = raw.replace(/^```(?:json)?\s*\r?\n?/i, '').replace(/\r?\n?```\s*$/i, '').trim();
    // Fallback: if still has backticks or doesn't start with {, extract JSON object
    if (raw.includes('`') || !raw.startsWith('{')) {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    }
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
  } catch (err) {
    console.warn('PDF parseWithAi failed, falling back to regex:', err.message);
    return null;
  }
}

/**
 * Simple regex-based fallback when Claude is not available.
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
  let dateBlockFirstDate = null; // First date in current date row (e.g. Mon–Fri) – use for content that follows
  const lines = (text || '').split(/\r?\n/).filter((l) => l.trim());

  for (const line of lines) {
    dueRe.lastIndex = 0;
    dateRe.lastIndex = 0;
    const dueMatch = dueRe.exec(line);
    if (dueMatch) {
      currentDate = normDate(dueMatch[1]) || currentDate;
      dateBlockFirstDate = null; // "due" breaks date block
    }

    const dateMatches = [];
    let m;
    while ((m = dateRe.exec(line)) !== null) {
      const d = normDate(m[0]);
      if (d) dateMatches.push(d);
    }

    let taskPart = line.replace(dateRe, '').replace(dueRe, '').replace(/\s+/g, ' ').trim();
    taskPart = taskPart.replace(/^(?:readings?|topic|assessment|homework|lab)\s*[:\-]\s*/i, '');
    const tl = (taskPart || '').toLowerCase();
    const isDateOnlyLine = dateMatches.length > 0 && (!taskPart || taskPart.length < 2 || noise.has(tl));

    if (isDateOnlyLine) {
      if (dateBlockFirstDate === null) dateBlockFirstDate = dateMatches[0];
      currentDate = dateBlockFirstDate;
      continue;
    }
    dateBlockFirstDate = null;
    if (dateMatches.length > 0) currentDate = dateMatches[0]; // Content line with inline date

    if (!taskPart || taskPart.length < 2) continue;
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
 * @returns {Promise<{tasks: Array, parser: string}>} tasks and parser used ('anthropic' or 'regex')
 */
async function parsePdfToTasks(buffer, filename = 'document.pdf') {
  const text = await extractPdfText(buffer);
  if (!text || text.trim().length < 10) {
    throw new Error('Could not extract text from PDF or PDF appears empty.');
  }

  let tasks = await parseWithAi(text, filename);
  if (tasks && tasks.length > 0) {
    return { tasks, parser: 'anthropic' };
  }
  tasks = parseWithRegex(text, filename);
  if (!tasks || tasks.length === 0) {
    throw new Error('No tasks found in PDF.');
  }
  return { tasks, parser: 'regex' };
}

module.exports = { parsePdfToTasks, extractPdfText };
