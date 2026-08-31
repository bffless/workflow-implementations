// Asserts every implementation's identity file (#420) matches its deploy workflow's alias.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
for (const dir of readdirSync('workflows', { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(`workflows/${d.name}/.bffless/workflow.json`)).map((d) => d.name)) {
  const alias = JSON.parse(readFileSync(`workflows/${dir}/.bffless/workflow.json`, 'utf8')).alias
  const deploy = readFileSync(`.github/workflows/deploy-${dir}.yml`, 'utf8')
  const match = /^\s*alias:\s*(\S+)\s*$/m.exec(deploy)?.[1]
  if (alias !== match) { console.error(`::error::workflows/${dir}/.bffless/workflow.json alias ${JSON.stringify(alias)} != deploy-${dir}.yml alias ${JSON.stringify(match ?? null)}`); process.exit(1) }
  console.log(`${dir}: alias "${alias}" matches deploy-${dir}.yml`)
}
