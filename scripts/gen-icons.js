const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const src = path.join(__dirname, '..', 'trigr-icon.svg');
const buildDir = path.join(__dirname, '..', 'build');

if (!fs.existsSync(src)) {
  console.error('Error: trigr-icon.svg not found in project root');
  process.exit(1);
}

fs.mkdirSync(buildDir, { recursive: true });

const icons = [
  { file: 'icon.png',       size: 256 },
  { file: 'icon-16.png',    size: 16  },
  { file: 'icon-32.png',    size: 32  },
  { file: 'icon-48.png',    size: 48  },
  { file: 'icon-64.png',    size: 64  },
  { file: 'icon-256.png',   size: 256 },
  { file: 'tray-icon.png',  size: 16  },
];

(async () => {
  for (const { file, size } of icons) {
    const dest = path.join(buildDir, file);
    await sharp(src).resize(size, size).png().toFile(dest);
    console.log(`Generated ${file} (${size}x${size})`);
  }
})();
