import axios from "axios";
import { spawn } from "child_process";
import fse from "fs-extra";
import path from "path";
import * as stream from "stream";
import { promisify } from "util";
import { CompilerKind, CompilerVersions } from "..";
import { assert } from "../../misc";
import { SolcInput } from "../input";
import { isExact } from "../version";
import {
    BINARIES_URL,
    CACHE_DIR,
    getCompilerMDForPlatform,
    getCompilerPrefixForOs,
    isSubDir
} from "./md";

const solc = require("solc");

export abstract class Compiler {
    constructor(public readonly version: string, public readonly path: string) {}

    abstract compile(inputJson: SolcInput): Promise<any>;
}

export class NativeCompiler extends Compiler {
    async compile(input: SolcInput): Promise<any> {
        const child = spawn(this.path, ["--standard-json"], {});

        return new Promise((resolve, reject) => {
            child.stdin.write(JSON.stringify(input), "utf-8");
            child.stdin.end();

            let stdout = "";
            let stderr = "";

            child.stdout.on("data", (data) => {
                stdout += data;
            });

            child.stderr.on("data", (data) => {
                stderr += data;
            });

            child.on("close", (code) => {
                if (code !== 0) {
                    reject(`Compiler exited with code ${code}, stderr: ${stderr}`);
                    return;
                }

                if (stderr !== "") {
                    reject(`Compiler exited with non-empty stderr: ${stderr}`);
                    return;
                }

                let outJson: any;

                try {
                    outJson = JSON.parse(stdout);
                } catch (e) {
                    reject(e);
                    return;
                }

                resolve(outJson);
            });
        });
    }
}

export class WasmCompiler extends Compiler {
    async compile(input: SolcInput): Promise<any> {
        const module = require(this.path);
        const wrappedModule = solc.setupMethods(module);
        const output = wrappedModule.compile(JSON.stringify(input));

        return JSON.parse(output);
    }
}

type CompilerMapping = [CompilerKind.Native, NativeCompiler] | [CompilerKind.WASM, WasmCompiler];

export async function getCompilerForVersion<T extends CompilerMapping>(
    version: string,
    kind: T[0]
): Promise<T[1] | undefined> {
    assert(
        isExact(version),
        "Version string must contain exact SemVer-formatted version without any operators"
    );

    let prefix: string | undefined;

    if (kind === CompilerKind.Native) {
        prefix = getCompilerPrefixForOs();
    } else if (kind === CompilerKind.WASM) {
        /**
         * Using BIN distribution here due to WASM distributions do not have 0.5.17 build and also OOM issues.
         *
         * @see https://github.com/ethereum/solidity/issues/10329
         *
         * @todo Reconsider this at some point.
         */
        prefix = "bin";
    } else {
        throw new Error(`Unsupported compiler kind "${kind}"`);
    }

    assert(CompilerVersions.includes(version), `Unsupported ${kind} compiler version ${version}`);

    if (prefix === undefined) {
        return undefined;
    }

    const md = await getCompilerMDForPlatform(prefix);
    const compilerFileName = md.releases[version];

    if (compilerFileName === undefined) {
        return undefined;
    }

    const compilerLocalPath = path.join(CACHE_DIR, prefix, compilerFileName);

    assert(
        isSubDir(compilerLocalPath, CACHE_DIR),
        `Path ${compilerLocalPath} escapes from cache dir ${CACHE_DIR}`
    );

    if (!fse.existsSync(compilerLocalPath)) {
        const response = await axios({
            method: "GET",
            url: `${BINARIES_URL}/${prefix}/${compilerFileName}`,
            responseType: "stream"
        });

        const target = fse.createWriteStream(compilerLocalPath, { mode: 0o555 });
        const pipeline = promisify(stream.pipeline);

        await pipeline(response.data, target);
    }

    if (kind === CompilerKind.Native) {
        return new NativeCompiler(version, compilerLocalPath);
    }

    if (kind === CompilerKind.WASM) {
        return new WasmCompiler(version, compilerLocalPath);
    }

    throw new Error(`Unable to detemine compiler constructor for kind "${kind}"`);
}
