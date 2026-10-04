const result = document.getElementById('result');

async function ask() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    result.textContent = 'Done. You can close this tab and record from the side panel.';
  } catch (err) {
    result.textContent = `Not allowed yet (${err.message}). Click the button, or allow the microphone from the icon in the address bar.`;
  }
}

document.getElementById('allow').addEventListener('click', ask);
ask();
