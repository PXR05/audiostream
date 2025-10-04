import { hash } from "@node-rs/argon2";

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
    console.error("Error encrypting text:", error);
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: bun run encrypt <text-to-encrypt>");
    console.log("\nExample:");
    console.log('  bun run encrypt "my secret password"');
    process.exit(1);
  }

  const textToEncrypt = args.join(" ");
  const encrypted = await encryptText(textToEncrypt);

  console.log("Original  :", textToEncrypt);
  console.log("Encrypted :", encrypted);
}

main();
