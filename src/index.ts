import { resolveAppFromInstruction } from "./core/app_resolver.js";
import 'dotenv/config';


async function main() {
  const userInput = process.argv.slice(2).join(" ");
  if (!userInput) {
    console.error("❌ Please provide an instruction, e.g.:");
    console.error('   npx ts-node src/index.ts "How do I filter a database in Notion?"');
    process.exit(1);
  }

  console.log(`\n🧠 Resolving app for instruction:\n"${userInput}"\n`);
  const appInfo = await resolveAppFromInstruction(userInput);

  if (!appInfo) {
    console.log("\n⚠️  App resolution aborted or not found.");
    process.exit(0);
  }

  console.log("\n✅ Resolved App Information:");
  console.log(appInfo);
  process.exit(0);
}

main();
