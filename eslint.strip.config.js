export default [
  {
    files: ["components/**/*.js", "popup.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-empty": "off",
      "strip/comments": "error",
      "strip/console": "error",
    },
    plugins: {
      strip: {
        rules: {
          comments: {
            meta: { fixable: "code", type: "suggestion" },
            create(context) {
              const sourceCode = context.sourceCode;
              return {
                Program() {
                  for (const comment of sourceCode.getAllComments()) {
                    context.report({
                      node: comment,
                      message: "Remove comment",
                      fix(fixer) {
                        let replacement = "";
                        const text = sourceCode.text;
                        for (let i = comment.range[0]; i < comment.range[1]; i++) {
                          replacement += text[i] === "\n" ? "\n" : " ";
                        }
                        return fixer.replaceTextRange(
                          comment.range,
                          replacement,
                        );
                      },
                    });
                  }
                },
              };
            },
          },
          console: {
            meta: { fixable: "code", type: "suggestion" },
            create(context) {
              return {
                ExpressionStatement(node) {
                  const callee = node.expression?.callee;
                  if (
                    node.expression?.type !== "CallExpression" ||
                    callee?.type !== "MemberExpression" ||
                    callee.object?.type !== "Identifier" ||
                    callee.object.name !== "console"
                  ) {
                    return;
                  }
                  context.report({
                    node,
                    message: "Remove console call",
                    fix(fixer) {
                      const src = context.sourceCode.text;
                      const range = node.range;
                      let start = range[0];
                      let end = range[1];
                      if (start > 0 && src[start - 1] === "\n") start--;
                      while (end < src.length && (src[end] === " " || src[end] === "\n")) end++;
                      if (end < src.length && src[end] === "\n") end++;
                      if (end > start && start > 0 && src[end - 1] === "\n" && src[start - 1] === "\n") {
                        return fixer.removeRange([start, end - 1]);
                      }
                      return fixer.removeRange([start, end]);
                    },
                  });
                },
              };
            },
          },
        },
      },
    },
  },
];
