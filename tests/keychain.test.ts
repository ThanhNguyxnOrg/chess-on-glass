import { afterEach, expect, test, vi } from "vitest";

// Never touch the real Keychain from tests: `security` is replaced with a fake.
const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...(await original<object>()), spawnSync }));

const { KeychainError, SERVICE, readSecret, saveSecret } = await import("../src/keychain.js");

afterEach(() => spawnSync.mockReset());

test("a saved key is read back without its trailing newline", () => {
  spawnSync.mockReturnValue({ status: 0, stdout: "sk-test\n", stderr: "" });
  expect(readSecret("openai-api-key")).toBe("sk-test");
  expect(spawnSync.mock.calls[0][1]).toEqual(["find-generic-password", "-s", SERVICE, "-a", "openai-api-key", "-w"]);
});

test("a missing key is null, and other failures are errors", () => {
  spawnSync.mockReturnValue({ status: 44, stdout: "", stderr: "not found" });
  expect(readSecret("openai-api-key")).toBeNull();
  spawnSync.mockReturnValue({ status: 51, stdout: "", stderr: "User interaction is not allowed." });
  expect(() => readSecret("openai-api-key")).toThrow(KeychainError);
});

test("keys go to `security -i` on stdin, in hex, never on the command line, and are read back", () => {
  spawnSync
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // the save
    .mockReturnValueOnce({ status: 0, stdout: "sk-secret\n", stderr: "" }); // reading it back
  saveSecret("openai-api-key", "sk-secret");
  const [command, args, options] = spawnSync.mock.calls[0];
  expect(command).toBe("security");
  expect(args).toEqual(["-i"]); // not `-w`: its prompt reads the terminal and keeps 128 characters
  const hex = Buffer.from("sk-secret").toString("hex");
  expect(options.input).toBe(`add-generic-password -U -s ${SERVICE} -a openai-api-key -X ${hex}\n`);
  expect(options.input).not.toContain("sk-secret");
  expect(spawnSync.mock.calls[1][1]).toEqual(["find-generic-password", "-s", SERVICE, "-a", "openai-api-key", "-w"]);
});

test("a key the Keychain didn't keep whole is an error", () => {
  spawnSync
    .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
    .mockReturnValueOnce({ status: 0, stdout: "sk-sec\n", stderr: "" });
  expect(() => saveSecret("openai-api-key", "sk-secret")).toThrow(KeychainError);
});
