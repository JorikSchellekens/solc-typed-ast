import expect from "expect";
import fse from "fs-extra";
import {
    ASTContext,
    ASTNodeFactory,
    ASTReader,
    compileJson,
    CompilerKind,
    compileSol,
    detectCompileErrors
} from "../../../src";

const cases: Array<[string, Array<[CompilerKind, string]>]> = [
    [
        "./test/samples/solidity/declarations/contract_050.json",
        [
            [CompilerKind.WASM, "./test/samples/solidity/declarations/contract_050.nodes.wasm.txt"],
            [
                CompilerKind.Native,
                "./test/samples/solidity/declarations/contract_050.nodes.native.txt"
            ]
        ]
    ],
    [
        "./test/samples/solidity/latest_08.sol",
        [
            [CompilerKind.WASM, "./test/samples/solidity/latest_08.nodes.wasm.txt"],
            [CompilerKind.Native, "./test/samples/solidity/latest_08.nodes.native.txt"]
        ]
    ]
];

describe(`ASTNodeFactory.copy() validation`, () => {
    for (const [sample, setups] of cases) {
        for (const [kind, snapshot] of setups) {
            describe(`[${kind}] ${sample} -> ${snapshot}`, () => {
                let data: any = {};

                before("Compile", async () => {
                    const result = await (sample.endsWith(".sol")
                        ? compileSol(sample, "auto", [], undefined, undefined, kind)
                        : compileJson(sample, "auto", undefined, undefined, kind));

                    const errors = detectCompileErrors(result.data);

                    expect(errors).toHaveLength(0);

                    data = result.data;
                });

                it("Validate copying results", () => {
                    const context = new ASTContext();

                    context.id = 1000;

                    const reader = new ASTReader(context);

                    const units = reader.read(data);

                    const factory = new ASTNodeFactory(context);

                    const clones = units.map((unit) => factory.copy(unit));
                    const result = clones
                        .map((unit) => unit.print(Number.MAX_SAFE_INTEGER))
                        .join("\n")
                        .replace(new RegExp(process.cwd(), "g"), ".");

                    // Uncomment next line to update snapshots
                    // fse.writeFileSync(snapshot, result, { encoding: "utf-8" });

                    const content = fse.readFileSync(snapshot, { encoding: "utf-8" });

                    expect(result).toEqual(content);
                });
            });
        }
    }
});
