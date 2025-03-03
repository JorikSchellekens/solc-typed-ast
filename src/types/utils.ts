import { lt, satisfies } from "semver";
import {
    ArrayTypeName,
    ContractDefinition,
    DataLocation,
    ElementaryTypeName,
    EnumDefinition,
    FunctionTypeName,
    Literal,
    LiteralKind,
    Mapping,
    PragmaDirective,
    SourceUnit,
    StructDefinition,
    TypeName,
    UserDefinedTypeName,
    UserDefinedValueTypeDefinition,
    VariableDeclaration
} from "../ast";
import { assert } from "../misc";
import { ABIEncoderVersion, ABIEncoderVersions } from "./abi";
import {
    AddressType,
    ArrayType,
    BoolType,
    BytesType,
    FixedBytesType,
    FunctionType,
    IntType,
    MappingType,
    PackedArrayType,
    PointerType,
    StringType,
    TupleType,
    TypeNode,
    UserDefinedType,
    UserDefinition
} from "./ast";

export type VersionDependentType = [TypeNode, string];

export function getTypeForCompilerVersion(
    typing: VersionDependentType,
    compilerVersion: string
): TypeNode | undefined {
    const [type, version] = typing;

    return satisfies(compilerVersion, version) ? type : undefined;
}

/**
 * Given a general type 'pattern' that doesn't contain any data locations, and a data location,
 * produce a concrete instance of the general type for the target location.
 * This is the inverse of `specializeType()`
 *
 * Note that this has to recursively fix sub-parts of compount types such as arrays and maps.
 * Note that this doesn't handle all possible expression types - just the ones that that may appear
 * in a variable declaration.
 *
 * @param type - general type "pattern"
 * @param loc - target location to specialize to
 * @returns specialized type
 */
export function specializeType(type: TypeNode, loc: DataLocation): TypeNode {
    assert(!(type instanceof PointerType), "Unexpected pointer type {0} in concretization.", type);
    assert(!(type instanceof TupleType), "Unexpected tuple type {0} in concretization.", type);

    // bytes and string
    if (type instanceof PackedArrayType) {
        return new PointerType(type, loc);
    }

    if (type instanceof ArrayType) {
        const concreteElT = specializeType(type.elementT, loc);

        return new PointerType(new ArrayType(concreteElT, type.size), loc);
    }

    if (type instanceof UserDefinedType) {
        const def = type.definition;

        assert(
            def !== undefined,
            "Can't concretize user defined type {0} with no corresponding definition.",
            type
        );

        if (def instanceof StructDefinition) {
            // Contracts are always concretized as storage poitners
            return new PointerType(type, loc);
        }

        // Enums are a value type
        return type;
    }

    if (type instanceof MappingType) {
        // Always treat map keys as in-memory copies
        const concreteKeyT = specializeType(type.keyType, DataLocation.Memory);
        // The result of map indexing is always a pointer to a value that lives in storage
        const concreteValueT = specializeType(type.valueType, DataLocation.Storage);
        // Maps always live in storage
        return new PointerType(new MappingType(concreteKeyT, concreteValueT), DataLocation.Storage);
    }

    // TODO: What to do about string literals?
    // All other types are "value" types.
    return type;
}

/**
 * Given a `TypeNode` `type` that is specialized to some storage location,
 * compute the original 'general' type that is independent of location.
 * This is the inverse of `specializeType()`
 *
 * Note that this doesn't handle all possible expression types - just the ones that that may appear
 * in a variable declaration.
 *
 * @param type - specialized type
 * @returns computed generalized type.
 */
export function generalizeType(type: TypeNode): [TypeNode, DataLocation | undefined] {
    if (type instanceof PointerType) {
        const [generalizedTo] = generalizeType(type.to);

        return [generalizedTo, type.location];
    }

    if (type instanceof ArrayType) {
        const [innerT] = generalizeType(type.elementT);

        return [new ArrayType(innerT, type.size), undefined];
    }

    if (type instanceof MappingType) {
        const [genearlKeyT] = generalizeType(type.keyType);
        const [generalValueT] = generalizeType(type.valueType);

        return [new MappingType(genearlKeyT, generalValueT), DataLocation.Storage];
    }

    // The only other types that contains sub-types are the FunctionType and TypeNameType. However those don't
    // get specialized/generalized w.r.t. storage locations.

    return [type, undefined];
}

export function getUserDefinedTypeFQName(def: UserDefinition): string {
    return def.vScope instanceof ContractDefinition ? `${def.vScope.name}.${def.name}` : def.name;
}

/**
 * Convert a given ast `TypeName` into a `TypeNode`. This produces "general
 * type patterns" without any specific storage information.
 *
 * @param astT - original AST `TypeName`
 * @returns equivalent `TypeNode`.
 */
export function typeNameToTypeNode(astT: TypeName): TypeNode {
    if (astT instanceof ElementaryTypeName) {
        const name = astT.name.trim();

        if (name === "bool") {
            return new BoolType();
        }

        const rxAddress = /^address *(payable)?$/;

        if (rxAddress.test(name)) {
            return new AddressType(astT.stateMutability === "payable");
        }

        const rxInt = /^(u?)int([0-9]*)$/;

        let m = name.match(rxInt);

        if (m !== null) {
            const signed = m[1] !== "u";
            const nBits = m[2] === "" ? 256 : parseInt(m[2]);

            return new IntType(nBits, signed);
        }

        const rxFixedBytes = /^bytes([0-9]+)$/;

        m = name.match(rxFixedBytes);

        if (m !== null) {
            const size = parseInt(m[1]);

            return new FixedBytesType(size);
        }

        if (name === "byte") {
            return new FixedBytesType(1);
        }

        if (name === "bytes") {
            return new BytesType();
        }

        if (name === "string") {
            return new StringType();
        }

        throw new Error(`NYI converting elementary AST Type ${name}`);
    }

    if (astT instanceof ArrayTypeName) {
        const elT = typeNameToTypeNode(astT.vBaseType);

        let size: bigint | undefined;

        if (astT.vLength !== undefined) {
            assert(
                astT.vLength instanceof Literal && astT.vLength.kind == LiteralKind.Number,
                "NYI non-literal array type sizes",
                astT
            );

            size = BigInt(astT.vLength.value);
        }

        return new ArrayType(elT, size);
    }

    if (astT instanceof UserDefinedTypeName) {
        const def = astT.vReferencedDeclaration;

        if (
            def instanceof StructDefinition ||
            def instanceof EnumDefinition ||
            def instanceof ContractDefinition ||
            def instanceof UserDefinedValueTypeDefinition
        ) {
            return new UserDefinedType(getUserDefinedTypeFQName(def), def);
        }

        throw new Error(`NYI typechecking of user-defined type ${def.print()}`);
    }

    if (astT instanceof FunctionTypeName) {
        /**
         * `vType` is always defined here for parameters if a function type.
         * Even in 0.4.x can't have function declarations with `var` args.
         */
        const args = astT.vParameterTypes.vParameters.map(variableDeclarationToTypeNode);
        const rets = astT.vReturnParameterTypes.vParameters.map(variableDeclarationToTypeNode);

        return new FunctionType(undefined, args, rets, astT.visibility, astT.stateMutability);
    }

    if (astT instanceof Mapping) {
        const keyT = typeNameToTypeNode(astT.vKeyType);
        const valueT = typeNameToTypeNode(astT.vValueType);

        return new MappingType(keyT, valueT);
    }

    throw new Error(`NYI converting AST Type ${astT.print()} to SType`);
}

/**
 * Computes a `TypeNode` equivalent of given `astT`,
 * specialized for location `loc` (if applicable).
 */
export function typeNameToSpecializedTypeNode(astT: TypeName, loc: DataLocation): TypeNode {
    return specializeType(typeNameToTypeNode(astT), loc);
}

/**
 * Given a `VariableDeclaration` node `decl` compute the `TypeNode` that corresponds to the variable.
 * This takes into account the storage location of the `decl`.
 */
export function variableDeclarationToTypeNode(decl: VariableDeclaration): TypeNode {
    assert(decl.vType !== undefined, "Expected {0} to have type", decl);

    return typeNameToSpecializedTypeNode(decl.vType, decl.storageLocation);
}

export function enumToIntType(decl: EnumDefinition): IntType {
    const length = decl.children.length;

    let size: number | undefined;

    for (let n = 8; n <= 32; n += 8) {
        if (length <= 2 ** n) {
            size = n;

            break;
        }
    }

    assert(
        size !== undefined,
        "Unable to detect enum type size - member count exceeds 2 ** 32",
        decl
    );

    return new IntType(size, false);
}

/**
 * Given a set of compiled units and their corresponding compiler version, determine the
 * correct ABIEncoder version for these units. If mulitple incompatible explicit pragmas are found,
 * throw an error.
 */
export function getABIEncoderVersion(
    units: SourceUnit[],
    compilerVersion: string
): ABIEncoderVersion {
    const explicitEncoderVersions = new Set<ABIEncoderVersion>();

    for (const unit of units) {
        for (const nd of unit.getChildrenByType(PragmaDirective)) {
            if (
                nd.vIdentifier === "experimental" &&
                nd.literals.length === 2 &&
                ABIEncoderVersions.has(nd.literals[1])
            ) {
                explicitEncoderVersions.add(nd.literals[1] as ABIEncoderVersion);
            }

            if (nd.vIdentifier === "abicoder") {
                let version: ABIEncoderVersion;
                const rawVer = nd.literals[1];

                if (rawVer === "v1") {
                    version = ABIEncoderVersion.V1;
                } else if (rawVer === "v2") {
                    version = ABIEncoderVersion.V2;
                } else {
                    throw new Error(`Unknown abicoder pragma version ${rawVer}`);
                }

                explicitEncoderVersions.add(version);
            }
        }
    }

    assert(
        explicitEncoderVersions.size < 2,
        `Multiple encoder versions found: ${[...explicitEncoderVersions].join(", ")}`
    );

    if (explicitEncoderVersions.size === 1) {
        return [...explicitEncoderVersions][0];
    }

    return lt(compilerVersion, "0.8.0") ? ABIEncoderVersion.V1 : ABIEncoderVersion.V2;
}
