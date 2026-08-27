// Model-authored text is data, never terminal control. A model — or a file it READs and echoes —
// can carry OSC 52 clipboard writes, OSC 8 links with deceptive targets, DCS/APC payloads, title
// changes, or `\r` overwrites. Everything the model authored passes through here before the
// client adds its own styling (plurnk#35).
export default class ModelText {
    // ESC-led sequences: CSI (`ESC [` … final @–~), OSC (`ESC ]` … BEL or ST), DCS/SOS/PM/APC
    // (`ESC P`/`X`/`^`/`_` … ST), and any remaining two-character escape.
    static #SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])|\x9b[0-?]*[ -/]*[@-~]|\x9d[^\x07\x9c\x1b]*(?:\x07|\x9c)?/g;
    // C0 controls except LF and TAB, DEL, and the C1 range (\x9b/\x9d are the 8-bit CSI/OSC, matched above with their bodies).
    static #CONTROL = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g;

    static plain(text: string): string {
        return text.replace(ModelText.#SEQUENCE, "").replace(ModelText.#CONTROL, "");
    }

    // Every string-valued field of a record the model may have authored (a Problem echoing the
    // model's own line, a proposal target), other values untouched.
    static plainFields<T extends object>(value: T): T {
        return Object.fromEntries(
            Object.entries(value).map(([key, field]) => [key, typeof field === "string" ? ModelText.plain(field) : field]),
        ) as T;
    }
}
