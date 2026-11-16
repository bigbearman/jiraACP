import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getClientFromConfig } from "../integrations/jira/client.js";

const cfg = {
  url: "https://myorg.atlassian.net",
  email: "dev@myorg.com",
  token: "my-api-token",
};

describe("getClientFromConfig", () => {
  it("returns an axios instance", () => {
    const client = getClientFromConfig(cfg);
    expect(client).toBeDefined();
    expect(typeof client.get).toBe("function");
    expect(typeof client.post).toBe("function");
  });

  it("sets baseURL to /rest/api/3", () => {
    const client = getClientFromConfig(cfg);
    expect(client.defaults.baseURL).toBe(
      "https://myorg.atlassian.net/rest/api/3",
    );
  });

  it("sets Authorization header as Basic base64", () => {
    const client = getClientFromConfig(cfg);
    const expected = `Basic ${Buffer.from("dev@myorg.com:my-api-token").toString("base64")}`;
    expect(client.defaults.headers["Authorization"]).toBe(expected);
  });

  it("sets Content-Type and Accept to application/json", () => {
    const client = getClientFromConfig(cfg);
    expect(client.defaults.headers["Content-Type"]).toBe("application/json");
    expect(client.defaults.headers["Accept"]).toBe("application/json");
  });

  it("creates independent clients for different configs", () => {
    const client1 = getClientFromConfig({
      ...cfg,
      url: "https://org1.atlassian.net",
    });
    const client2 = getClientFromConfig({
      ...cfg,
      url: "https://org2.atlassian.net",
    });
    expect(client1.defaults.baseURL).not.toBe(client2.defaults.baseURL);
  });

  it("correctly encodes special characters in credentials", () => {
    const special = {
      url: "https://x.atlassian.net",
      email: "user+tag@x.com",
      token: "p@ss:w0rd!",
    };
    const client = getClientFromConfig(special);
    const expected = `Basic ${Buffer.from("user+tag@x.com:p@ss:w0rd!").toString("base64")}`;
    expect(client.defaults.headers["Authorization"]).toBe(expected);
  });
});

describe("getClient (env-based)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env["JIRA_TEST123_URL"];
    delete process.env["JIRA_TEST123_TOKEN"];
    delete process.env["JIRA_TEST123_EMAIL"];
    vi.resetModules();
  });

  it("returns a client for a configured instance", async () => {
    process.env["JIRA_TEST123_URL"] = "https://test123.atlassian.net";
    process.env["JIRA_TEST123_TOKEN"] = "tok";
    process.env["JIRA_TEST123_EMAIL"] = "x@test.com";
    const { getClient } = await import("../integrations/jira/client.js");
    const client = getClient("test123");
    expect(client.defaults.baseURL).toContain("test123.atlassian.net");
  });

  it("throws for unknown instance", async () => {
    const { getClient } = await import("../integrations/jira/client.js");
    expect(() => getClient("__no_such_instance__")).toThrow(
      /Unknown Jira instance/,
    );
  });

  it("skips instance when URL is set but TOKEN or EMAIL is missing", async () => {
    process.env["JIRA_INCOMPLETE_URL"] = "https://incomplete.atlassian.net";
    // TOKEN and EMAIL intentionally not set
    const { INSTANCES } = await import("../integrations/jira/client.js");
    expect(INSTANCES["incomplete"]).toBeUndefined();
    delete process.env["JIRA_INCOMPLETE_URL"];
  });
});
