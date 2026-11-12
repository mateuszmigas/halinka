import { describe, expect, it } from "vitest";

import { findWorkflowFile, isWorkflowPath, isWorkflowRef, toWorkflowPath } from "./paths";

describe("workflow paths", () => {
  it.each([".halinka/workflows/build.yml", ".halinka/workflows/build.yaml"])(
    "isWorkflowPath accepts %s",
    (path) => {
      expect(isWorkflowPath(path)).toBe(true);
    },
  );

  it.each([
    ".halinka/workflows/nested/build.yml",
    ".halinka/workflows/readme.md",
    ".halinka/config.yml",
    ".halinka/workflows/../config.yml",
    "./.halinka/workflows/build.yml",
  ])("isWorkflowPath refuses %s", (path) => {
    expect(isWorkflowPath(path)).toBe(false);
  });

  it.each(["build", "fix_2", "my flow.v2.yaml", ".halinka/workflows/build.yml"])(
    "isWorkflowRef accepts %s",
    (ref) => {
      expect(isWorkflowRef(ref)).toBe(true);
    },
  );

  it.each([
    "../build",
    "../build.yml",
    "nested/build.yml",
    "build.yml.bak",
    ".halinka/config.yml",
    "-build",
  ])("isWorkflowRef refuses %s", (ref) => {
    expect(isWorkflowRef(ref)).toBe(false);
  });

  it("findWorkflowFile finds a .yaml file by name", () => {
    const files = { ".halinka/workflows/build.yaml": "schema_version: 1\nname: Build\n" };

    expect(findWorkflowFile(files, "build")).toEqual({
      path: ".halinka/workflows/build.yaml",
      file: "schema_version: 1\nname: Build\n",
    });
  });

  it("findWorkflowFile prefers .yml to .yaml", () => {
    const files = {
      ".halinka/workflows/build.yaml": "yaml",
      ".halinka/workflows/build.yml": "yml",
    };

    expect(findWorkflowFile(files, "build")?.path).toBe(".halinka/workflows/build.yml");
  });

  it("findWorkflowFile finds a file by its path", () => {
    const files = {
      ".halinka/workflows/build.yaml": "yaml",
      ".halinka/workflows/build.yml": "yml",
    };

    expect(findWorkflowFile(files, ".halinka/workflows/build.yaml")?.path).toBe(
      ".halinka/workflows/build.yaml",
    );
  });

  it("findWorkflowFile finds a file by its file name", () => {
    const files = {
      ".halinka/workflows/build.yaml": "yaml",
      ".halinka/workflows/build.yml": "yml",
    };

    expect(findWorkflowFile(files, "build.yaml")?.path).toBe(".halinka/workflows/build.yaml");
  });

  it("findWorkflowFile finds nothing for a missing workflow", () => {
    expect(findWorkflowFile({}, "build")).toBeUndefined();
  });

  it.each([
    [".halinka/workflows/build.yml", ".halinka/workflows/build.yml"],
    ["build.yaml", ".halinka/workflows/build.yaml"],
  ])("toWorkflowPath gives the path of %s", (workflow, path) => {
    expect(toWorkflowPath(workflow)).toBe(path);
  });

  it.each(["build", "nested/build.yml", ".halinka/config.yml", "build.md"])(
    "toWorkflowPath gives nothing for %s",
    (workflow) => {
      expect(toWorkflowPath(workflow)).toBeUndefined();
    },
  );
});
