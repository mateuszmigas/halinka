export const firstLine = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let read = "";
  while (!read.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    read += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return read.split("\n")[0] ?? "";
};
