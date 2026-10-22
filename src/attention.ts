// {§cli-attention} One signal that the person is needed, whatever needs them; sinks such as the bell subscribe to it.

export type AttentionReason = "reply" | "stopped" | "failed" | "review" | "question";

export type AttentionSink = (reason: AttentionReason) => void;

// A concluded loop as the person meets it: its reply, its stop (499), or any other end.
export const concluded = (finalStatus: number, hitMaxTurns: boolean): AttentionReason =>
    finalStatus === 200 && !hitMaxTurns ? "reply" : finalStatus === 499 ? "stopped" : "failed";

// The signal raised once reaches every sink.
export const attention = (sinks: readonly AttentionSink[]): AttentionSink => (reason) => {
    for (const sink of sinks) sink(reason);
};

// The terminal bell: one BEL on a stream that is a terminal; any other stream hears nothing.
export const bell = (stream: { readonly isTTY?: boolean; write(chunk: string): unknown }): AttentionSink => () => {
    if (stream.isTTY === true) stream.write("\x07");
};
