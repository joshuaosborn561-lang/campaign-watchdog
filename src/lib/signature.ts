/**
 * Double-signature detector for sent email bodies. A "double signature" is a
 * copy sign-off ("Joshua Osborn / SalesGlider") followed by the mailbox
 * signature appended by Smartlead, so the prospect sees two sign-off blocks.
 *
 * Ported from the Campaign Watchdog routine's analyze.mjs (read-only text analysis).
 */

export function toLines(html: unknown): string[] {
  let h = String(html ?? "");
  h = h.split(/<blockquote|\bOn [A-Z][a-z]{2},? .{5,80}wrote:/)[0] ?? "";
  h = h
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  h = h
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"');
  return h
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const CLOSING =
  /^(best|thanks|thank you|cheers|regards|best regards|kind regards|warm regards|talk soon|all the best|sincerely|warmly|appreciate it)[,.!]*$/i;
const GREET = /^(hi|hey|hello|dear|morning|afternoon|yo)\b/i;
const clean = (line: string) => line.replace(/^[—–\-~]+\s*/, "");

function nameish(raw: string): boolean {
  const line = clean(raw);
  if (CLOSING.test(line)) return true;
  if (line.length > 40 || /[?!:;]/.test(line) || GREET.test(line) || /^p\.?s/i.test(line)) {
    return false;
  }
  const words = line.replace(/[,.]$/, "").split(/\s+/);
  if (words.length > 4) return false;
  return words.every(
    (word) =>
      /^[A-Z][A-Za-z.'&-]*$/.test(word) ||
      /^(of|and|the|&|\||-)$/.test(word) ||
      /^\S+@\S+$/.test(word) ||
      /^[\d()+ .-]{7,}$/.test(word),
  );
}

const personLine = (line: string) => {
  const words = clean(line).replace(/[,.]$/, "").split(/\s+/);
  return !CLOSING.test(clean(line)) && words.length >= 1 && words.length <= 3;
};

export interface SignatureAnalysis {
  double: boolean;
  blocks: string[][];
  tail: string[];
}

export function analyzeSignature(html: unknown): SignatureAnalysis {
  const lines = toLines(html);
  const start = Math.max(0, lines.length - 8);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // "Name," at the very top is the greeting, not a sign-off.
    const greeting = i <= 1 && /^[A-Z][a-z'-]+(\s[A-Z][a-z'-]+)?,$/.test(line);
    if (!greeting && nameish(line)) {
      if (!current) {
        current = [];
        blocks.push(current);
      }
      current.push(line);
    } else {
      current = null;
    }
  }
  let double = blocks.length >= 2;
  // A repeated name inside one block, e.g. "— Joshua Osborn" then "Joshua Osborn".
  for (const block of blocks) {
    const firsts = block
      .filter(personLine)
      .map((line) => clean(line).split(/\s+/)[0].replace(/[,.]$/, "").toLowerCase());
    for (let i = 0; i < firsts.length; i++) {
      for (let j = i + 1; j < firsts.length; j++) {
        const a = firsts[i];
        const b = firsts[j];
        if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) {
          double = true;
        }
      }
    }
  }
  return { double, blocks, tail: lines.slice(-5) };
}
