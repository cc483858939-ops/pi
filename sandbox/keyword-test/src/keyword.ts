/**
 * A tiny, dependency-free keyword recognizer.
 *
 * It scans a text for a set of keywords and reports every non-overlapping
 * match together with its position. Matching is case-insensitive by default
 * and word-boundary aware, so "cat" does not match inside "category".
 */

export interface KeywordMatch {
  /** The keyword as it was registered. */
  readonly keyword: string;
  /** The exact slice of the input that matched. */
  readonly matched: string;
  /** Start index of the match in the input text. */
  readonly index: number;
  /** End index (exclusive) of the match in the input text. */
  readonly end: number;
}

export interface RecognizerOptions {
  /** Case-insensitive matching. Defaults to `true`. */
  readonly ignoreCase?: boolean;
  /** Require word boundaries around the keyword. Defaults to `true`. */
  readonly wholeWord?: boolean;
}

/** Characters allowed inside a "word" for boundary detection. */
const WORD_CHAR = /[A-Za-z0-9_]/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class KeywordRecognizer {
  readonly #ignoreCase: boolean;
  readonly #wholeWord: boolean;
  readonly #keywords: string[];

  constructor(keywords: readonly string[] = [], options: RecognizerOptions = {}) {
    this.#ignoreCase = options.ignoreCase ?? true;
    this.#wholeWord = options.wholeWord ?? true;

    const normalized = keywords
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword.length > 0);

    // De-duplicate, longest first so that more specific keywords win.
    this.#keywords = [...new Set(normalized)].sort(
      (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
    );
  }

  /** The registered keywords, longest first. */
  get keywords(): readonly string[] {
    return this.#keywords;
  }

  /** Returns the keywords found in `text`, or an empty array. */
  find(text: string): KeywordMatch[] {
    const matches: KeywordMatch[] = [];
    if (this.#keywords.length === 0 || text.length === 0) {
      return matches;
    }

    const flags = this.#ignoreCase ? "gi" : "g";
    const pattern = new RegExp(
      this.#keywords.map(escapeRegExp).join("|"),
      flags,
    );

    // Track consumed ranges so overlapping keywords do not double-report.
    let consumedUntil = 0;

    for (const raw of text.matchAll(pattern)) {
      const index = raw.index;
      const matched = raw[0];
      if (index === undefined || matched.length === 0) {
        continue;
      }
      if (index < consumedUntil) {
        continue;
      }
      if (this.#wholeWord) {
        const before = text[index - 1];
        const after = text[index + matched.length];
        if (isWordChar(before) || isWordChar(after)) {
          continue;
        }
      }

      matches.push({
        keyword: this.#resolveKeyword(matched),
        matched,
        index,
        end: index + matched.length,
      });
      consumedUntil = index + matched.length;
    }

    return matches.sort((a, b) => a.index - b.index);
  }

  /** Returns `true` when at least one keyword occurs in `text`. */
  test(text: string): boolean {
    return this.find(text).length > 0;
  }

  /** Returns the distinct keywords found in `text`. */
  matchedKeywords(text: string): string[] {
    return [...new Set(this.find(text).map((match) => match.keyword))];
  }

  /** Highlights every match by wrapping it in `before`/`after` markers. */
  highlight(text: string, before = "[", after = "]"): string {
    const matches = this.find(text);
    if (matches.length === 0) {
      return text;
    }

    let result = "";
    let cursor = 0;
    for (const match of matches) {
      result += text.slice(cursor, match.index) + before + match.matched + after;
      cursor = match.end;
    }
    return result + text.slice(cursor);
  }

  #resolveKeyword(matched: string): string {
    if (!this.#ignoreCase) {
      return matched;
    }
    // When several keywords differ only by case, the one whose casing is
    // exactly the matched text wins; otherwise fall back to the first
    // case-insensitive equivalent.
    if (this.#keywords.includes(matched)) {
      return matched;
    }
    const lower = matched.toLowerCase();
    return (
      this.#keywords.find((keyword) => keyword.toLowerCase() === lower) ??
      matched
    );
  }
}
