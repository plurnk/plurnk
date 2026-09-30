// [§cli-configuration-source] Only the daemon identifies the winning input.
export const configurationSource = (entry: object): string => {
    if (!("provenance" in entry) || typeof entry.provenance !== "object" || entry.provenance === null) return "";
    const { provenance } = entry;
    return "source" in provenance && typeof provenance.source === "string"
        ? `  source=${provenance.source}`
        : "";
};
