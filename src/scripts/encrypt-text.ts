import { hash } from "@node-rs/argon2";
import { logger } from "../utils/logger";

async function encryptText(text: string): Promise<string> {
  try {
    const hashedText = await hash(text, {
      memoryCost: 19456,
      timeCost: 2,
      outputLen: 32,
      parallelism: 1,
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
