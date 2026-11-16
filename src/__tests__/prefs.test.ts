import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-prefs-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

describe("getVerbosity", () => {
  it("returns 'medium' when no prefs file exists", async () => {
    const { getVerbosity } = await import("../integrations/telegram/prefs.js");
    expect(getVerbosity("123")).toBe("medium");
  });

  it("returns 'medium' for unknown chatId", async () => {
    const { getVerbosity, setVerbosity } =
      await import("../integrations/telegram/prefs.js");
    setVerbosity("999", "high");
    expect(getVerbosity("000")).toBe("medium");
  });

  it("returns saved verbosity for a chatId", async () => {
    const { getVerbosity, setVerbosity } =
      await import("../integrations/telegram/prefs.js");
    setVerbosity("123", "low");
    expect(getVerbosity("123")).toBe("low");
  });

  it("accepts numeric chatId", async () => {
    const { getVerbosity, setVerbosity } =
      await import("../integrations/telegram/prefs.js");
    setVerbosity(456, "high");
    expect(getVerbosity(456)).toBe("high");
  });

  it("treats numeric and string chatId as the same key", async () => {
    const { getVerbosity, setVerbosity } =
      await import("../integrations/telegram/prefs.js");
    setVerbosity(789, "low");
    expect(getVerbosity("789")).toBe("low");
  });

  it("returns 'medium' on corrupted prefs file", async () => {
    const prefsDir = path.join(tmpHome, ".jira-acp");
    fs.mkdirSync(prefsDir, { recursive: true });
    fs.writeFileSync(path.join(prefsDir, "telegram-prefs.json"), "INVALID");
    const { getVerbosity } = await import("../integrations/telegram/prefs.js");
    expect(getVerbosity("123")).toBe("medium");
  });
});

describe("setVerbosity", () => {
  it("creates prefs file if it does not exist", async () => {
    const { setVerbosity } = await import("../integrations/telegram/prefs.js");
    setVerbosity("111", "high");
    const prefsFile = path.join(tmpHome, ".jira-acp", "telegram-prefs.json");
    expect(fs.existsSync(prefsFile)).toBe(true);
  });

  it("persists multiple chat IDs independently", async () => {
    const { getVerbosity, setVerbosity } =
      await import("../integrations/telegram/prefs.js");
    setVerbosity("aaa", "low");
    setVerbosity("bbb", "high");
    expect(getVerbosity("aaa")).toBe("low");
    expect(getVerbosity("bbb")).toBe("high");
  });

  it("overwrites existing verbosity for same chatId", async () => {
    const { getVerbosity, setVerbosity } =
      await import("../integrations/telegram/prefs.js");
    setVerbosity("555", "high");
    setVerbosity("555", "low");
    expect(getVerbosity("555")).toBe("low");
  });
});
