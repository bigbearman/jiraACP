import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// We need to control HOME_DIR — patch the module before importing
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-loader-test-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

function writeProjectConfig(projectsDir: string, name: string, data: object) {
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectsDir, `${name}.json`),
    JSON.stringify(data),
  );
}

const minimalProject = {
  name: "my-project",
  jira: {
    instance: "myorg",
    url: "https://myorg.atlassian.net",
    email: "dev@myorg.com",
    token: "jira-secret",
    projectKey: "PROJ",
    assignees: ["acc-1"],
  },
  github: { owner: "myorg", repo: "my-repo", token: "ghp-secret" },
  workspace: { rootDir: "/tmp/my-repo" },
  telegram: { botToken: "123:ABC", chatId: "-100123" },
};

// ── deepMerge (tested indirectly via loadConfig with global config) ──────────

describe("deepMerge via loadConfig", () => {
  it("global token is used when project omits it", async () => {
    // Patch os.homedir to point to tmpHome
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { loadConfig } = await import("../config/loader.js");

    const projectsDir = path.join(tmpHome, ".jira-acp", "projects");
    const globalPath = path.join(tmpHome, ".jira-acp", "config.json");

    // Global config has telegram botToken
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({ telegram: { botToken: "global-token" } }),
    );

    // Project config has everything except botToken
    const { telegram: _t, ...noTelegram } = minimalProject;
    writeProjectConfig(projectsDir, "my-project", {
      ...noTelegram,
      telegram: { chatId: "-100123" },
    });

    const config = loadConfig("my-project");
    expect(config.telegram.botToken).toBe("global-token");
    expect(config.telegram.chatId).toBe("-100123");
  });

  it("project value overrides global", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { loadConfig } = await import("../config/loader.js");

    const projectsDir = path.join(tmpHome, ".jira-acp", "projects");
    const globalPath = path.join(tmpHome, ".jira-acp", "config.json");

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({ pipeline: { maxCostUsdPerRun: 1.0 } }),
    );

    writeProjectConfig(projectsDir, "my-project", {
      ...minimalProject,
      pipeline: { maxCostUsdPerRun: 5.0 },
    });

    const config = loadConfig("my-project");
    expect(config.pipeline.maxCostUsdPerRun).toBe(5.0);
  });

  it("arrays are replaced, not concatenated", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { loadConfig } = await import("../config/loader.js");

    const projectsDir = path.join(tmpHome, ".jira-acp", "projects");
    const globalPath = path.join(tmpHome, ".jira-acp", "config.json");

    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({ jira: { assignees: ["global-acc"] } }),
    );

    writeProjectConfig(projectsDir, "my-project", {
      ...minimalProject,
      jira: { ...minimalProject.jira, assignees: ["project-acc"] },
    });

    const config = loadConfig("my-project");
    // Project assignees replace global — no merge concat
    expect(config.jira.assignees).toEqual(["project-acc"]);
  });

  it("throws if project config not found", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { loadConfig } = await import("../config/loader.js");
    expect(() => loadConfig("nonexistent")).toThrow(/No config found/);
  });
});

describe("loadGlobalConfig no global file", () => {
  it("loads project config successfully when no global config file exists", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { loadConfig } = await import("../config/loader.js");
    // Only create project config — no global config file
    const projectsDir = path.join(tmpHome, ".jira-acp", "projects");
    writeProjectConfig(projectsDir, "my-project", minimalProject);
    const config = loadConfig("my-project");
    expect(config.name).toBe("my-project");
  });
});

describe("loadGlobalConfig schema failure", () => {
  it("returns {} when global config JSON fails schema validation", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { loadConfig } = await import("../config/loader.js");
    const globalPath = path.join(tmpHome, ".jira-acp", "config.json");
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    // Valid JSON but jira.assignees must be array — this fails deepPartial schema
    fs.writeFileSync(
      globalPath,
      JSON.stringify({ jira: { assignees: "not-an-array" } }),
    );
    const projectsDir = path.join(tmpHome, ".jira-acp", "projects");
    writeProjectConfig(projectsDir, "my-project", minimalProject);
    // Global config silently ignored — project config still loads
    const config = loadConfig("my-project");
    expect(config.name).toBe("my-project");
  });
});

describe("loadGlobalConfig catch", () => {
  it("returns {} when global config JSON is corrupted", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { loadConfig } = await import("../config/loader.js");
    const globalPath = path.join(tmpHome, ".jira-acp", "config.json");
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, "NOT VALID JSON");
    const projectsDir = path.join(tmpHome, ".jira-acp", "projects");
    writeProjectConfig(projectsDir, "my-project", minimalProject);
    // Should not throw — corrupted global config is silently ignored
    const config = loadConfig("my-project");
    expect(config.name).toBe("my-project");
  });
});

describe("configExists", () => {
  it("returns false when config does not exist", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { configExists } = await import("../config/loader.js");
    expect(configExists("nonexistent-project")).toBe(false);
  });

  it("returns true when config exists", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { configExists } = await import("../config/loader.js");
    const projectsDir = path.join(tmpHome, ".jira-acp", "projects");
    writeProjectConfig(projectsDir, "my-project", minimalProject);
    expect(configExists("my-project")).toBe(true);
  });
});

describe("saveConfig", () => {
  it("writes config JSON to projects dir", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { saveConfig } = await import("../config/loader.js");
    saveConfig("newproj", { name: "newproj" });
    const saved = path.join(tmpHome, ".jira-acp", "projects", "newproj.json");
    expect(fs.existsSync(saved)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(saved, "utf8")) as {
      name: string;
    };
    expect(parsed.name).toBe("newproj");
  });
});

describe("getRunsDir", () => {
  it("returns runs dir path under HOME_DIR", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { getRunsDir } = await import("../config/loader.js");
    const result = getRunsDir("myproject");
    expect(result).toContain("runs");
    expect(result).toContain("myproject");
  });
});

describe("detectProjectName", () => {
  it("falls back to folder name when dir has no git remote", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { detectProjectName } = await import("../config/loader.js");
    // tmpDir has no git remote → spawnSync returns non-zero → fallback
    const name = detectProjectName(tmpHome);
    expect(name).toBe(path.basename(tmpHome));
  });

  it("extracts project name from https git remote URL", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { detectProjectName } = await import("../config/loader.js");
    // Init a real git repo with a remote so spawnSync succeeds
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: tmpHome });
    spawnSync(
      "git",
      ["remote", "add", "origin", "https://github.com/myorg/myrepo.git"],
      { cwd: tmpHome },
    );
    const name = detectProjectName(tmpHome);
    expect(name).toBe("myorg-myrepo");
  });

  it("falls back to folder name when git remote URL does not match owner/repo pattern", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { detectProjectName } = await import("../config/loader.js");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: tmpHome });
    // URL without owner/repo — regex won't match
    spawnSync("git", ["remote", "add", "origin", "https://example.com"], {
      cwd: tmpHome,
    });
    const name = detectProjectName(tmpHome);
    expect(name).toBe(path.basename(tmpHome));
  });
});

describe("listProjects", () => {
  it("returns empty array when projects dir missing", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { listProjects } = await import("../config/loader.js");
    expect(listProjects()).toEqual([]);
  });

  it("lists all .json files without extension", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const { listProjects } = await import("../config/loader.js");

    const projectsDir = path.join(tmpHome, ".jira-acp", "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, "alpha.json"), "{}");
    fs.writeFileSync(path.join(projectsDir, "beta.json"), "{}");
    fs.writeFileSync(path.join(projectsDir, "README.md"), "not a project");

    const projects = listProjects();
    expect(projects).toContain("alpha");
    expect(projects).toContain("beta");
    expect(projects).not.toContain("README");
  });
});
