import { createServer, type AddressInfo } from "node:net";

// A loopback port the kernel just handed out and this process released: closed by evidence, for a
// test that needs an address nothing answers at, instead of a number assumed to be free.
export const releasedPort = (): Promise<number> => new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
    });
});

export const unreachableUrl = async (): Promise<string> => `http://127.0.0.1:${await releasedPort()}`;
