export type OutputChunk = { stream: "stdout" | "stderr"; text: string };

// Gives the first `maxPartChars` characters at once, and the last ones with the cut length at `end`.
export class OutputLimit {
  private headLeft: number;
  private tail: OutputChunk[] = [];
  // the index of the first kept chunk in `tail`; a shift per dropped chunk is slow
  private start = 0;
  private tailLength = 0;
  private cutLength = 0;

  constructor(private readonly maxPartChars: number) {
    this.headLeft = maxPartChars;
  }

  push(chunk: OutputChunk): OutputChunk | undefined {
    if (this.headLeft === 0) {
      this.keep(chunk);
      return undefined;
    }
    if (chunk.text.length <= this.headLeft) {
      this.headLeft -= chunk.text.length;
      return chunk;
    }
    const head = chunk.text.slice(0, this.headLeft);
    this.headLeft = 0;
    this.keep({ ...chunk, text: chunk.text.slice(head.length) });
    return { ...chunk, text: head };
  }

  end() {
    return { cutLength: this.cutLength, tail: this.tail.slice(this.start) };
  }

  private keep(chunk: OutputChunk) {
    this.tail.push(chunk);
    this.tailLength += chunk.text.length;
    while (this.tailLength > this.maxPartChars) {
      const first = this.tail[this.start]!;
      const dropped = Math.min(this.tailLength - this.maxPartChars, first.text.length);
      if (dropped === first.text.length) this.start++;
      else this.tail[this.start] = { ...first, text: first.text.slice(dropped) };
      this.tailLength -= dropped;
      this.cutLength += dropped;
    }
    if (this.start > this.tail.length / 2) {
      this.tail = this.tail.slice(this.start);
      this.start = 0;
    }
  }
}
