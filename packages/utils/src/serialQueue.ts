// One task at a time, in the order of the calls; a failed task does not stop the next one.
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>) {
    const done = this.tail.then(task);
    this.tail = done.catch(() => {});
    return done;
  }

  async idle() {
    await this.tail;
  }
}
