import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { dualHarnessTypert } from './scripts/typert-dual-codecs.ts'

export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  clean: false,
  fixedExtension: false,
  // The generator writes lib/typert.host.js and lib/typert.remote-client.js;
  // the wrapper then gives every codec in them the create() factory harness
  // 0.1.7 requires, beside the schema 0.1.5 requires (see the script).
  plugins: [dualHarnessTypert(typertPlugin())],
}
