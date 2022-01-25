FROM node:12.22.9 as build

# TODO: remove `--branch native_compilers` param
RUN git clone --branch native_compilers --depth 1 https://github.com/ConsenSys/solc-typed-ast.git /solc-typed-ast

WORKDIR /solc-typed-ast
RUN npm ci && npm link
RUN npm run test

FROM node:12.22.9
COPY --from=build /solc-typed-ast/.compiler_cache /.compiler_cache
ENV SOL_AST_COMPILER_CACHE=/.compiler_cache
