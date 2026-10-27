const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function auditAssumptions(stdout, { expectedReports, coqlib }) {
  const expected = [
    "int",
    "add",
    "sub",
    "land",
    "lor",
    "lxor",
    "lsl",
    "lsr",
    "ltb",
    "eqb",
  ]
    .map((name) => `PrimInt63.${name}`)
    .sort();
  const blocks = [
    ...stdout.matchAll(/^Axioms:\n([\s\S]*?)(?=^Theory:|^Chars|(?![\s\S]))/gm),
  ];
  const observed = [
    ...new Set(
      blocks.flatMap((block) =>
        [...block[1].matchAll(/^([^\s:]+)\s*:/gm)].map((match) => match[1]),
      ),
    ),
  ].sort();
  const theories = [
    ...stdout.matchAll(/^Theory:\n([\s\S]*?)(?=\nChars|(?![\s\S]))/gm),
  ].map((match) => match[1].trim());
  // DEFENSE: rocq-of-solidity includes admitted lemmas. A theorem audit must
  // expose every assumption, including identifiers containing primes or Unicode.
  if (
    JSON.stringify(observed) !== JSON.stringify(expected) ||
    (stdout.match(/^Axioms:/gm) ?? []).length !== expectedReports ||
    blocks.length !== expectedReports ||
    theories.length !== expectedReports ||
    theories.some((mode) => mode !== "Set is impredicative")
  ) {
    throw new Error(
      `Unexpected Rocq assumptions or theory mode: ${JSON.stringify({ observed, theories })}`,
    );
  }
  const source = path.join(coqlib, "theories/Numbers/Cyclic/Int63/PrimInt63.v");
  const declarations = fs.readFileSync(source, "utf8");
  for (const primitive of expected) {
    const name = primitive.split(".")[1];
    if (
      !new RegExp(`^Primitive ${name}\\s*:=\\s*#int63_`, "m").test(declarations)
    ) {
      throw new Error(
        `${primitive} is not registered as a kernel Primitive in ${source}`,
      );
    }
  }
  return {
    registeredKernelPrimitives: observed,
    unprovedLemmas: [],
    logic: "Set is impredicative",
    primitiveSource: {
      path: source,
      sha256: crypto.createHash("sha256").update(declarations).digest("hex"),
    },
  };
}

module.exports = { auditAssumptions };
