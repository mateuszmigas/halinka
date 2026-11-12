import { rm } from "node:fs/promises";
import { join } from "node:path";

import { readTextFile, replaceFile } from "@halinka/utils/fs";
import { halinkaHome } from "@halinka/utils/halinkaHome";

export const defaultPort = 7070;

const urlPath = () => join(halinkaHome(), "server.json");

const parseUrl = (text: string) => {
  try {
    const { url } = JSON.parse(text) as { url?: unknown };
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
};

export const readLocalServerUrl = async () => {
  const text = await readTextFile(urlPath());
  if (text === undefined) return `http://127.0.0.1:${defaultPort}`;
  const url = parseUrl(text);
  if (url === undefined) throw new Error(`${urlPath()} has no server URL. Remove the file.`);
  return url;
};

export const writeLocalServerUrl = (url: string) => replaceFile(urlPath(), JSON.stringify({ url }));

export const deleteLocalServerUrl = () => rm(urlPath(), { force: true });
