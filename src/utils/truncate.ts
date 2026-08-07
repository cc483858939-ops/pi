import { TextDecoder } from "node:util";

function decodeValidUtf8(buffer: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = buffer.length; end >= Math.max(0, buffer.length - 4); end -= 1) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // Retry without a potentially partial trailing code point.
    }
  }
  return buffer.toString("utf8");
}

export function truncateUtf8Prefix(buffer: Buffer, maxBytes: number): {
  text: string;
  truncated: boolean;
} {
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString("utf8"), truncated: false };
  }
  return {
    text: decodeValidUtf8(buffer.subarray(0, maxBytes)),
    truncated: true,
  };
}

export function truncateUtf8Tail(buffer: Buffer, maxBytes: number): {
  text: string;
  truncated: boolean;
} {
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString("utf8"), truncated: false };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const start = buffer.length - maxBytes;
  for (let offset = start; offset <= Math.min(buffer.length, start + 4); offset += 1) {
    try {
      return { text: decoder.decode(buffer.subarray(offset)), truncated: true };
    } catch {
      // Retry after a potentially partial leading code point.
    }
  }
  return { text: buffer.subarray(start).toString("utf8"), truncated: true };
}

export class BoundedProcessOutput {
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBuffer = Buffer.alloc(0);
  private wasTruncated = false;

  constructor(private readonly maxBytes: number) {}

  append(stream: "stdout" | "stderr", chunk: Buffer): void {
    const boundedChunk =
      chunk.length > this.maxBytes ? chunk.subarray(chunk.length - this.maxBytes) : chunk;
    if (chunk.length > boundedChunk.length) {
      this.wasTruncated = true;
    }

    if (stream === "stdout") {
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, boundedChunk]);
    } else {
      this.stderrBuffer = Buffer.concat([this.stderrBuffer, boundedChunk]);
    }

    this.trim(stream);
  }

  private trim(preferred: "stdout" | "stderr"): void {
    let overflow = this.stdoutBuffer.length + this.stderrBuffer.length - this.maxBytes;
    if (overflow <= 0) {
      return;
    }
    this.wasTruncated = true;

    const trimBuffer = (stream: "stdout" | "stderr"): void => {
      if (overflow <= 0) {
        return;
      }
      const current = stream === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
      const amount = Math.min(overflow, current.length);
      const next = current.subarray(amount);
      if (stream === "stdout") {
        this.stdoutBuffer = next;
      } else {
        this.stderrBuffer = next;
      }
      overflow -= amount;
    };

    trimBuffer(preferred);
    trimBuffer(preferred === "stdout" ? "stderr" : "stdout");
  }

  result(): { stdout: string; stderr: string; truncated: boolean } {
    return {
      stdout: truncateUtf8Tail(this.stdoutBuffer, this.stdoutBuffer.length).text,
      stderr: truncateUtf8Tail(this.stderrBuffer, this.stderrBuffer.length).text,
      truncated: this.wasTruncated,
    };
  }
}
