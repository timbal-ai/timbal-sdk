import { test, expect, describe, beforeEach, mock } from "bun:test";
import { Timbal } from "../lib/timbal";
import type { TimbalConfig } from "../types";

// Mock fetch
global.fetch = mock(() => Promise.resolve({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ status: "ok" }),
})) as any;

describe("Timbal", () => {
  let timbal: Timbal;
  let config: TimbalConfig;

  beforeEach(() => {
    config = {
      apiKey: "test-key",
      baseUrl: "https://api.test.com",
    };
    timbal = new Timbal(config);
    (global.fetch as any).mockClear();
  });

  describe("initialization", () => {
    test("should initialize with config", () => {
      const timbalConfig = timbal.getConfig();
      expect(timbalConfig.apiKey).toBe("test-key");
      expect(timbalConfig.baseUrl).toBe("https://api.test.com");
    });

    test("should initialize query methods", () => {
      expect(typeof timbal.query).toBe("function");
      expect(typeof timbal.queryByParams).toBe("function");
    });
  });

  describe("testConnection", () => {
    test("should return true for successful connection", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "healthy" }),
      });

      const result = await timbal.testConnection();
      expect(result).toBe(true);
    });

    test("should return false for failed connection", async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error("Network error"));

      const result = await timbal.testConnection();
      expect(result).toBe(false);
    });
  });

  describe("configuration", () => {
    test("should update configuration", () => {
      timbal.updateConfig({ timeout: 15000 });
      const config = timbal.getConfig();
      expect(config.timeout).toBe(15000);
    });

    test("should provide access to API client", () => {
      const apiClient = timbal.getApiClient();
      expect(apiClient).toBeDefined();
      expect(typeof apiClient.get).toBe("function");
      expect(typeof apiClient.post).toBe("function");
    });
  });
});