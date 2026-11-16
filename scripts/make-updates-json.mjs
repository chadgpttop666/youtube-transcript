// Манифест обновлений для Firefox. Подписанное расширение раз в сутки
// запрашивает update_url из своего manifest.json, находит там версию новее
// установленной и ставит её по ссылке. Файл кладётся в каждый релиз, а
// update_url указывает на «последний релиз», поэтому он всегда свежий.
//
// Использование: node scripts/make-updates-json.mjs <путь к подписанному xpi>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'firefox-extension', 'manifest.json'), 'utf8'));
const repository = process.env.GITHUB_REPOSITORY || 'chadgpttop666/youtube-transcript';

const xpiPath = process.argv[2];
if (!xpiPath) {
  console.error('Укажите путь к подписанному .xpi');
  process.exit(1);
}

const { version } = manifest;
const gecko = manifest.browser_specific_settings.gecko;
// Хеш защищает от подмены файла по дороге: Firefox сверит его перед установкой.
const hash = createHash('sha256').update(readFileSync(xpiPath)).digest('hex');

const updates = {
  addons: {
    [gecko.id]: {
      updates: [
        {
          version,
          update_link: `https://github.com/${repository}/releases/download/v${version}/${basename(xpiPath)}`,
          update_hash: `sha256:${hash}`,
          applications: { gecko: { strict_min_version: gecko.strict_min_version } },
        },
      ],
    },
  },
};

process.stdout.write(`${JSON.stringify(updates, null, 2)}\n`);
