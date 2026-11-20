interface ProfileStateResponse {
  success?: boolean;
  profileId?: string;
  profileName?: string;
  customProfileName?: string;
  profileEmail?: string;
  bridgeConnected?: boolean;
}

function getRequiredElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing popup element #${id}`);
  }
  return el as T;
}

function renderState(state: ProfileStateResponse): void {
  const statusDot = getRequiredElement<HTMLSpanElement>("statusDot");
  const statusText = getRequiredElement<HTMLSpanElement>("statusText");
  const profileIdValue = getRequiredElement<HTMLDivElement>("profileIdValue");
  const emailField = getRequiredElement<HTMLDivElement>("emailField");
  const profileEmailValue = getRequiredElement<HTMLDivElement>("profileEmailValue");
  const profileNameInput = getRequiredElement<HTMLInputElement>("profileNameInput");

  const connected = Boolean(state.bridgeConnected);
  statusDot.classList.toggle("connected", connected);
  statusText.textContent = connected ? "Connected" : "Disconnected";

  profileIdValue.textContent = state.profileId || "-";
  if (state.profileEmail) {
    emailField.style.display = "block";
    profileEmailValue.textContent = state.profileEmail;
  } else {
    emailField.style.display = "none";
  }

  profileNameInput.value = state.customProfileName ?? "";
  profileNameInput.placeholder = state.profileEmail || state.profileId || "e.g. work, personal";
}

async function loadState(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({
    type: "GET_PROFILE_STATE"
  })) as ProfileStateResponse | undefined;
  if (res) {
    renderState(res);
  }
}

async function saveProfileName(): Promise<void> {
  const profileNameInput = getRequiredElement<HTMLInputElement>("profileNameInput");
  const saveStatus = getRequiredElement<HTMLDivElement>("saveStatus");
  const res = (await chrome.runtime.sendMessage({
    type: "SET_PROFILE_NAME",
    profileName: profileNameInput.value
  })) as ProfileStateResponse | undefined;
  if (res) {
    renderState(res);
    saveStatus.textContent = `Saved as "${res.profileName ?? ""}"`;
    setTimeout(() => {
      saveStatus.textContent = "";
    }, 2000);
  }
}

function initPopup(): void {
  const saveBtn = getRequiredElement<HTMLButtonElement>("saveBtn");
  const profileNameInput = getRequiredElement<HTMLInputElement>("profileNameInput");

  saveBtn.addEventListener("click", () => {
    void saveProfileName();
  });
  profileNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void saveProfileName();
    }
  });

  void loadState();
}

initPopup();
