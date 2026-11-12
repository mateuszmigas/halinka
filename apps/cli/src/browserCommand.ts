export const browserCommand = (platform: NodeJS.Platform, url: string): [string, string[]] => {
  if (platform === "darwin") return ["open", [url]];
  // Not `cmd /c start`: cmd reads & in a URL as a second command.
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
};
