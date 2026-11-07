import {describe,it,expect,vi} from "vitest";
import {hermesCredential} from "../scripts/hermes-credential.mts";
const settings={home:"/Users/test",account:"test",node:"/opt/bin/node",op:"/opt/bin/op",environment:"umcywiy3b7hzpi2ln4zqrcywi4"};
describe("Hermes Desktop command credential",()=>{
 it("retrieves the proxy key in private pipes without putting either credential in argv or config",async()=>{
  const run=vi.fn(async(file:string,_args:string[],_env:NodeJS.ProcessEnv)=>file==="/usr/bin/security"?"SYNTHETIC_SERVICE_TOKEN\n":"SYNTHETIC_PROXY_KEY");
  expect(await hermesCredential(settings,run)).toBe("SYNTHETIC_PROXY_KEY");
  expect(run.mock.calls[1][2].OP_SERVICE_ACCOUNT_TOKEN).toBe("SYNTHETIC_SERVICE_TOKEN");
  expect(JSON.stringify(run.mock.calls.map(c=>c[1]))).not.toContain("SYNTHETIC");
  expect(run.mock.calls[1][1]).toContain("--no-masking");
  expect(run.mock.calls[0][2].OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
 });
 it("fails closed and sanitizes failed commands and malformed credentials",async()=>{
  for(const output of ["", "short", "op://not-resolved", "key-with\nnewline"]){
   const run=vi.fn(async(file:string)=>file==="/usr/bin/security"?"SYNTHETIC_SERVICE_TOKEN":output);
   await expect(hermesCredential(settings,run)).rejects.toThrow("Hermes proxy credential unavailable");
  }
  await expect(hermesCredential(settings,async()=>{throw Error("SECRET") })).rejects.toThrow("Hermes proxy credential unavailable");
 });
});
