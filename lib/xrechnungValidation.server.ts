import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export const kositRelease = {
  validator: "1.6.3",
  rules: "XRechnung 3.0.2 / 2026-08-31",
  jarSha256: "799e64befca97d4080e03608c80b85dd5a5ecc5f4ae4f35d1116ec2855b9a7c9",
  zipSha256: "2530cd107c414511c5d0462ec10f886910395abfca820db82e83d70bf01221a8",
} as const;

export async function validateXRechnung(xml: Buffer, assets: { jar: string; configurationZip: string }) {
  const [jar, zip] = await Promise.all([readFile(assets.jar), readFile(assets.configurationZip)]);
  if (hash(jar) !== kositRelease.jarSha256 || hash(zip) !== kositRelease.zipSha256) {
    throw new Error("xrechnung_validator_artifacts_unverified");
  }
  const folder = await mkdtemp(join(tmpdir(), "gloa-xrechnung-"));
  try {
    const rules = join(folder, "rules");
    const output = join(folder, "reports");
    await Promise.all([mkdir(rules), mkdir(output)]);
    const jarPath = join(folder, "validator.jar");
    const zipPath = join(folder, "configuration.zip");
    const xmlPath = join(folder, "document.xml");
    await Promise.all([writeFile(jarPath, jar), writeFile(zipPath, zip), writeFile(xmlPath, xml)]);
    const options = { windowsHide: true, timeout: 45000, maxBuffer: 1048576 };
    await run("jar", ["xf", zipPath], { ...options, cwd: rules });
    await run("java", ["-jar", jarPath, "-s", join(rules, "scenarios.xml"), "-r", rules, "-o", output, xmlPath],
      { ...options, cwd: folder });
    const names = (await readdir(output)).filter(name => name.endsWith(".xml"));
    if (names.length !== 1) throw new Error("xrechnung_validation_report_missing");
    const report = await readFile(join(output, names[0]));
    if (!report.length) throw new Error("xrechnung_validation_report_missing");
    return { xmlSha256: hash(xml), reportSha256: hash(report), validator: kositRelease.validator, rules: kositRelease.rules };
  } finally {
    // mkdtemp produces a single private directory under the OS temp directory.
    await rm(folder, { recursive: true, force: true });
  }
}
