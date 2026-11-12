// The URL of the server as an `http` origin, whatever the scheme of the socket.
export const serverOriginOf = (url: string) => new URL(url.replace(/^ws(s?):/, "http$1:")).origin;

// Undefined when the runner signed the public URL of the server.
export const wrongServerReason = (signedUrl: string, publicUrl: string) =>
  signedUrl === serverOriginOf(publicUrl)
    ? undefined
    : `The runner connected to ${signedUrl}, not to ${publicUrl}`;
