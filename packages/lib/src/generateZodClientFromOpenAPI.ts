import path from "node:path";

import type { HelperOptions } from "handlebars";
import { create } from "handlebars";
import type { OpenAPIObject } from "openapi3-ts";
import { capitalize, pick } from "pastable/server";
import type { Options } from "prettier";
import { match } from "ts-pattern";

import { maybePretty } from "./maybePretty";
import type { TemplateContext } from "./template-context";
import { getZodClientTemplateContext } from "./template-context";

type GenerateZodClientFromOpenApiArgs<TOptions extends TemplateContext["options"] = TemplateContext["options"]> = {
    openApiDoc: OpenAPIObject;
    templatePath?: string;
    prettierConfig?: Options | null;
    options?: TOptions;
} & (
    | {
          distPath?: never;
          /** when true, will only return the result rather than writing it to a file, mostly used for easier testing purpose */
          disableWriteToFile: true;
      }
    | { distPath: string; disableWriteToFile?: false }
);

export const generateZodClientFromOpenAPI = async <TOptions extends TemplateContext["options"]>({
    openApiDoc,
    distPath,
    templatePath,
    prettierConfig,
    options,
    disableWriteToFile,
}: GenerateZodClientFromOpenApiArgs<TOptions>): Promise<
    TOptions extends NonNullable<TemplateContext["options"]>
        ? undefined extends TOptions["groupStrategy"]
            ? string
            : TOptions["groupStrategy"] extends "none" | "tag" | "method"
            ? string
            : Record<string, string>
        : string
> => {
    const data = getZodClientTemplateContext(openApiDoc, options);
    const groupStrategy = options?.groupStrategy ?? "none";

    if (!templatePath) {
        templatePath = match(groupStrategy)
            .with("none", "tag-file", "method-file", () => path.join(__dirname, "../src/template.hbs"))
            .with("tag", "method", () => path.join(__dirname, "../src/template-grouped.hbs"))
            .exhaustive();
    }

    const fs = await import("fs-extra");
    const source = await fs.readFile(templatePath, "utf8");
    const hbs = getHandlebars();
    const template = hbs.compile(source);
    const willWriteToFile = !disableWriteToFile && distPath;
    // TODO parallel writes ? does it really matter here ?

    if (groupStrategy.includes("file")) {
        const outputByGroupName: Record<string, string> = {};

        if (willWriteToFile) {
            await fs.ensureDir(distPath);
        }

        const groupNames = Object.fromEntries(
            Object.keys(data.endpointsGroups).map((groupName) => [
                options?.apiClientName ?? `${capitalize(groupName)}Api`,
                groupName,
            ])
        );

        const indexSource = await fs.readFile(path.join(__dirname, "../src/template-grouped-index.hbs"), "utf8");
        const indexTemplate = hbs.compile(indexSource);
        const indexOutput = maybePretty(indexTemplate({ groupNames }), prettierConfig);
        outputByGroupName["__index"] = indexOutput;

        if (willWriteToFile) {
            await fs.writeFile(path.join(distPath, "index.ts"), indexOutput);
        }

        const commonSource = await fs.readFile(path.join(__dirname, "../src/template-grouped-common.hbs"), "utf8");
        const commonTemplate = hbs.compile(commonSource);
        const commonSchemaNames = [...(data.commonSchemaNames ?? [])];
        const commonOutput = maybePretty(
            commonTemplate({
                schemas: pick(data.schemas, commonSchemaNames),
                types: pick(data.types, commonSchemaNames),
            }),
            prettierConfig
        );
        outputByGroupName["__common"] = commonOutput;

        if (willWriteToFile) {
            await fs.writeFile(path.join(distPath, "common.ts"), commonOutput);
        }

        for (const groupName in data.endpointsGroups) {
            const groupOutput = template({
                ...data,
                ...data.endpointsGroups[groupName],
                options: {
                    ...options,
                    groupStrategy: "none",
                    apiClientName: options?.apiClientName ?? `${capitalize(groupName)}Api`,
                },
            });
            const prettyGroupOutput = maybePretty(groupOutput, prettierConfig);
            outputByGroupName[groupName] = prettyGroupOutput;

            if (willWriteToFile) {
                console.log("Writing to", path.join(distPath, `${groupName}.ts`));
                await fs.writeFile(path.join(distPath, `${groupName}.ts`), prettyGroupOutput);
            }
        }

        return outputByGroupName as any;
    }

    const output = template({ ...data, options: { ...options, apiClientName: options?.apiClientName ?? "api" } });
    const prettyOutput = maybePretty(output, prettierConfig);

    if (willWriteToFile) {
        await fs.writeFile(distPath, prettyOutput);
    }

    return prettyOutput as any;
};

export const getHandlebars = () => {
    const instance = create();
    instance.registerHelper("ifeq", function (a: string, b: string, options: HelperOptions) {
        if (a === b) {
            // @ts-expect-error
            return options.fn(this);
        }

        // @ts-expect-error
        return options.inverse(this);
    });

    return instance;
};
