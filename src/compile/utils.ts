import fse from "fs-extra";
import path from "path";
import { FileSystemResolver, getCompilerForVersion, ImportResolver, LocalNpmResolver } from ".";
import {
    CompilerVersionSelectionStrategy,
    LatestVersionInEachSeriesStrategy,
    RangeVersionStrategy,
    VersionDetectionStrategy
} from "./compiler_selection";
import { CompilationOutput, CompilerKind } from "./constants";
import { Remapping } from "./import_resolver";
import { findAllFiles } from "./inference";
import { createCompilerInput } from "./input";

export interface MemoryStorage {
    [path: string]: {
        source: string | undefined;
    };
}

export interface CompileResult {
    data: any;
    compilerVersion?: string;
    files: Map<string, string>;
}

export interface CompileFailure {
    errors: string[];
    compilerVersion?: string;
}

export class CompileInferenceError extends Error {}

export class CompileFailedError extends Error {
    failures: CompileFailure[];

    constructor(entries: CompileFailure[]) {
        super();

        this.failures = entries;

        const formattedErrorStr = entries.map(
            (entry) => `==== ${entry.compilerVersion} ===:\n ${entry.errors.join("\n")}\n`
        );

        this.message = `Compiler Errors: ${formattedErrorStr}`;
    }
}

function consistentlyContainsOneOf(
    sources: { [key: string]: any },
    ...properties: string[]
): boolean {
    const sections = Object.values(sources);

    for (const property of properties) {
        if (sections.every((section) => property in section)) {
            return true;
        }
    }

    return false;
}

export function parsePathRemapping(remapping: string[]): Remapping[] {
    const rxRemapping = /^(([^:]*):)?([^=]*)=(.+)$/;
    const result: Array<[string, string, string]> = remapping.map((entry) => {
        const matches = entry.match(rxRemapping);

        if (matches === null) {
            throw new Error(`Invalid remapping entry "${entry}"`);
        }

        return [matches[2] === undefined ? "" : matches[2], matches[3], matches[4]];
    });

    return result;
}

export function resolveFiles(
    files: Map<string, string>,
    remapping: string[],
    resolvers: ImportResolver[]
): void {
    const parsedRemapping = parsePathRemapping(remapping);
    findAllFiles(files, parsedRemapping, resolvers);
}

function fillFilesFromSources(
    files: Map<string, string>,
    sources: { [fileName: string]: any }
): void {
    for (const [fileName, section] of Object.entries(sources)) {
        if (section && typeof section.source === "string") {
            files.set(fileName, section.source);
        }
    }
}

function getCompilerVersionStrategy(
    sources: string[],
    versionOrStrategy: string | CompilerVersionSelectionStrategy
): CompilerVersionSelectionStrategy {
    if (versionOrStrategy === "auto") {
        return new VersionDetectionStrategy(sources, new LatestVersionInEachSeriesStrategy());
    }

    if (typeof versionOrStrategy === "string") {
        return new RangeVersionStrategy([versionOrStrategy]);
    }

    return versionOrStrategy;
}

export async function compile(
    files: Map<string, string>,
    remapping: string[],
    version: string,
    compilationOutput: CompilationOutput[] = [CompilationOutput.ALL],
    compilerSettings?: any,
    kind = CompilerKind.WASM
): Promise<any> {
    const compilerInput = createCompilerInput(
        files,
        remapping,
        compilationOutput,
        compilerSettings
    );

    const compiler = await getCompilerForVersion(version, kind);

    if (compiler === undefined) {
        throw new Error(
            `Couldn't find "${kind}" compiler for version ${version} for current platform`
        );
    }

    return compiler.compile(compilerInput);
}

export function detectCompileErrors(data: any): string[] {
    const errors: string[] = [];

    if (data.errors instanceof Array) {
        for (const error of data.errors) {
            const typeOf = typeof error;

            if (typeOf === "object") {
                /**
                 * Solc >= 0.5
                 */
                if (error.severity === "error") {
                    errors.push(error.formattedMessage);
                }
            } else if (typeOf === "string") {
                /**
                 * Solc < 0.5
                 */
                if (!error.match("Warning")) {
                    errors.push(error);
                }
            }
        }
    }

    return errors;
}

export async function compileSourceString(
    fileName: string,
    sourceCode: string,
    version: string | CompilerVersionSelectionStrategy,
    remapping: string[],
    compilationOutput: CompilationOutput[] = [CompilationOutput.ALL],
    compilerSettings?: any,
    kind?: CompilerKind
): Promise<CompileResult> {
    const entrySourceUnit = fileName;
    const entryFileDir = path.dirname(entrySourceUnit);

    const files = new Map([[entrySourceUnit, sourceCode]]);
    const resolvers = [new FileSystemResolver(), new LocalNpmResolver(entryFileDir)];

    resolveFiles(files, remapping, resolvers);

    const compilerVersionStrategy = getCompilerVersionStrategy([...files.values()], version);
    const failures: CompileFailure[] = [];

    for (const compilerVersion of compilerVersionStrategy.select()) {
        const data = await compile(
            files,
            remapping,
            compilerVersion,
            compilationOutput,
            compilerSettings,
            kind
        );

        const errors = detectCompileErrors(data);

        if (errors.length === 0) {
            return { data, compilerVersion, files };
        }

        failures.push({ compilerVersion, errors });
    }

    throw new CompileFailedError(failures);
}

export async function compileSol(
    fileName: string,
    version: string | CompilerVersionSelectionStrategy,
    remapping: string[],
    compilationOutput: CompilationOutput[] = [CompilationOutput.ALL],
    compilerSettings?: any,
    kind?: CompilerKind
): Promise<CompileResult> {
    const sourceCode = fse.readFileSync(fileName, { encoding: "utf-8" });

    return compileSourceString(
        fileName,
        sourceCode,
        version,
        remapping,
        compilationOutput,
        compilerSettings,
        kind
    );
}

export async function compileJsonData(
    fileName: string,
    data: any,
    version: string | CompilerVersionSelectionStrategy,
    compilationOutput: CompilationOutput[] = [CompilationOutput.ALL],
    compilerSettings?: any,
    kind?: CompilerKind
): Promise<CompileResult> {
    const files = new Map<string, string>();

    if (!(data instanceof Object && data.sources instanceof Object)) {
        throw new Error(`Unable to find required properties in "${fileName}"`);
    }

    const sources: { [fileName: string]: any } = data.sources;

    if (consistentlyContainsOneOf(sources, "ast", "legacyAST", "AST")) {
        const compilerVersion = undefined;
        const errors = detectCompileErrors(data);

        if (errors.length) {
            throw new CompileFailedError([{ compilerVersion, errors }]);
        }

        fillFilesFromSources(files, sources);

        return { data, compilerVersion, files };
    }

    if (consistentlyContainsOneOf(sources, "source")) {
        for (const [fileName, fileData] of Object.entries<{ source: string }>(sources)) {
            files.set(fileName, fileData.source);
        }

        const compilerVersionStrategy = getCompilerVersionStrategy([...files.values()], version);
        const failures: CompileFailure[] = [];

        for (const compilerVersion of compilerVersionStrategy.select()) {
            const compileData = await compile(
                files,
                [],
                compilerVersion,
                compilationOutput,
                compilerSettings,
                kind
            );

            const errors = detectCompileErrors(compileData);

            if (errors.length === 0) {
                return { data: compileData, compilerVersion, files };
            }

            failures.push({ compilerVersion, errors });
        }

        throw new CompileFailedError(failures);
    }

    throw new Error(
        "Unable to process data structure: neither consistent AST or code values are present"
    );
}

export async function compileJson(
    fileName: string,
    version: string | CompilerVersionSelectionStrategy,
    compilationOutput: CompilationOutput[] = [CompilationOutput.ALL],
    compilerSettings?: any,
    kind?: CompilerKind
): Promise<CompileResult> {
    const data = fse.readJSONSync(fileName);

    return compileJsonData(fileName, data, version, compilationOutput, compilerSettings, kind);
}
