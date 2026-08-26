import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  clean: false,
  fixedExtension: false,
  plugins: [typertPlugin()],
}
