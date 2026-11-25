function hexToHsv(hex) {
  const [red, green, blue] = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const value = Math.max(red, green, blue);
  const delta = value - Math.min(red, green, blue);
  if (!delta) return {hue: 0, saturation: 0, value};
  const sector = value === red ? (green - blue) / delta
    : value === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  return {hue: (sector * 60 + 360) % 360, saturation: delta / value, value};
}

function hsvToRgb({hue, saturation, value}) {
  return [5, 3, 1].map(offset => {
    const sector = (offset + hue / 60) % 6;
    return Math.round(255 * value * (1 - saturation * Math.max(0, Math.min(sector, 4 - sector, 1))));
  });
}

function hsvToHex(color) {
  return '#' + hsvToRgb(color).map(channel => channel.toString(16).padStart(2, '0')).join('');
}

export function attachColorWheel({canvas, target, brightness, hex, preview, read, write, commit}) {
  const context = canvas.getContext('2d');
  const size = canvas.width;
  const center = size / 2;
  const radius = center - 7;
  const colors = new Map();
  let spectrum;
  let activePointer = null;

  function colorAt(x, y, value) {
    return {
      hue: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360,
      saturation: Math.min(1, Math.hypot(x, y) / radius),
      value,
    };
  }

  function draw(color) {
    if (!context) return;
    if (!spectrum) {
      spectrum = context.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x + 0.5 - center;
          const dy = y + 0.5 - center;
          const opacity = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx, dy)));
          if (!opacity) continue;
          const [red, green, blue] = hsvToRgb(colorAt(dx, dy, 1));
          const i = (y * size + x) * 4;
          spectrum.data[i] = red;
          spectrum.data[i + 1] = green;
          spectrum.data[i + 2] = blue;
          spectrum.data[i + 3] = opacity * 255;
        }
      }
    }
    context.putImageData(spectrum, 0, 0);
    context.save();
    context.globalCompositeOperation = 'source-atop';
    context.fillStyle = `rgba(0, 0, 0, ${1 - color.value})`;
    context.fillRect(0, 0, size, size);
    context.restore();

    const angle = color.hue * Math.PI / 180;
    const distance = radius * color.saturation;
    context.beginPath();
    context.arc(center + Math.cos(angle) * distance, center + Math.sin(angle) * distance, 5, 0, Math.PI * 2);
    context.lineWidth = 3.5;
    context.strokeStyle = '#24272c';
    context.stroke();
    context.lineWidth = 1.8;
    context.strokeStyle = '#fff';
    context.stroke();
  }

  function currentColor() {
    const field = target.value;
    const value = read(field).toLowerCase();
    const cached = colors.get(field);
    if (cached?.hex === value) return cached.color;
    const color = hexToHsv(value);
    colors.set(field, {hex: value, color});
    return color;
  }

  function refresh() {
    const color = currentColor();
    const value = read(target.value);
    if (document.activeElement !== hex) hex.value = value.toUpperCase();
    preview.style.setProperty('--wheel-color', value);
    brightness.value = String(Math.round(color.value * 100));
    brightness.style.setProperty('--wheel-high-color', hsvToHex({...color, value: 1}));
    draw(color);
  }

  function setColor(color) {
    const value = hsvToHex(color);
    colors.set(target.value, {hex: value, color});
    write(target.value, value);
  }

  function pick(event) {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const x = (event.clientX - box.left) * size / box.width - center;
    const y = (event.clientY - box.top) * size / box.height - center;
    setColor(colorAt(x, y, currentColor().value));
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || activePointer !== null) return;
    activePointer = event.pointerId;
    canvas.setPointerCapture(activePointer);
    pick(event);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId === activePointer) pick(event);
  });
  canvas.addEventListener('lostpointercapture', event => {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    commit();
  });
  target.addEventListener('change', refresh);
  brightness.addEventListener('input', () => {
    setColor({...currentColor(), value: Number(brightness.value) / 100});
  });
  brightness.addEventListener('change', commit);
  hex.addEventListener('change', () => {
    const value = hex.value.trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{6}$/.test(value)) {
      write(target.value, `#${value}`);
      commit();
    }
    hex.value = read(target.value).toUpperCase();
  });
  hex.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      hex.blur();
    }
  });
  return {refresh};
}
