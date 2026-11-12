export class OutputTail {
  private buffer = "";

  constructor(
    private readonly maxLines: number,
    private readonly maxLength: number,
  ) {}

  push(chunk: string) {
    this.buffer = (this.buffer + chunk).slice(-4 * this.maxLength);
  }

  text() {
    return this.buffer
      .trimEnd()
      .split("\n")
      .slice(-this.maxLines)
      .join("\n")
      .slice(-this.maxLength);
  }
}
