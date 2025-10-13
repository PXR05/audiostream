import { argon2id } from "hash-wasm";
import { logger } from "../utils/logger";

async function encryptText(text: string): Promise<string> {
  try {
    const hashedText = await argon2id({
      password: text,
      salt: new Uint8Array(16),
      parallelism: 1,
      iterations: 2,
      memorySize: 19456,
      hashLength: 32,
      outputType: "encoded",
    });
    return hashedText;
  } catch (error) {
    logger.error("Text encryption failed", error, { context: "ENCRYPT" });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    logger.info("Usage: bun run encrypt <text-to-encrypt>", {
      context: "ENCRYPT",
      timestamp: false,
    });
    logger.info("\nExample:", { context: "ENCRYPT", timestamp: false });
    logger.info('  bun run encrypt "my secret password"', {
      context: "ENCRYPT",
      timestamp: false,
    });
    process.exit(1);
  }

  const textToEncrypt = args.join(" ");
  const encrypted = await encryptText(textToEncrypt);

  logger.info("Original  : " + textToEncrypt, {
    context: "ENCRYPT",
    timestamp: false,
  });
  logger.info("Encrypted : " + encrypted, {
    context: "ENCRYPT",
    timestamp: false,
  });
}

main();
