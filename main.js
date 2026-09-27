import { smartPhonicsWordBank, initSmartPhonicsWordBank, playerSymbols, englishVoices } from "./config.js"

const PLAYER_SETS_KEY = "phonics_player_sets"
const SHARED_SETS_KEY = "shared_player_sets"
const SHARED_ACTIVE_PLAYERS_KEY = "shared_active_players"
const UPSTASH_URL_KEY = "upstash_redis_url"
const UPSTASH_TOKEN_KEY = "upstash_redis_token"
const STATS_KEY = "wordTacToe_stats"
const MAX_PLAYERS = 5
let lastVoiceId = null

document.addEventListener("DOMContentLoaded", async () => {
  // --- STATE ---
  let gameState = {
    currentView: "setup",
    isMuted: false,
    setup: {
      players: [],
      // We can add other setup-specific state here later
    },
  }
  let areGameEventListenersAttached = false
  let wordCache = []
  let isOrderLocked = false
  let isMoveProcessing = false
  let hasSeenQuotaWarning = false
  let currentTurnCellClicked = false
  let playingTurnAudio = null
  let pendingTurnAnnouncementTimeout = null
  let currentLoadedSetName = null

  const sounds = {
    click: new Audio("sounds/click.mp3"),
    block: new Audio("sounds/block.mp3"),
    score: new Audio("sounds/score.mp3"),
    gameOver: new Audio("sounds/game-over.mp3"),
    eliminated: new Audio("sounds/eliminated.mp3"),
  }

  // --- WEB AUDIO API (For pitch-shifted score sounds and timed block sounds) ---
  let webAudioCtx = null
  let scoreAudioBuffer = null
  let blockAudioBuffer = null
  let isScoreAudioLoading = false
  let isBlockAudioLoading = false

  function getAudioContext() {
    if (!webAudioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext
      if (AudioCtxClass) {
        webAudioCtx = new AudioCtxClass()
      }
    }
    if (webAudioCtx && webAudioCtx.state === "suspended") {
      webAudioCtx.resume().catch(() => {})
    }
    return webAudioCtx
  }

  async function loadScoreAudioBuffer() {
    if (scoreAudioBuffer || isScoreAudioLoading) return scoreAudioBuffer
    const ctx = getAudioContext()
    if (!ctx) return null
    isScoreAudioLoading = true
    try {
      const response = await fetch("sounds/score.mp3")
      const arrayBuffer = await response.arrayBuffer()
      scoreAudioBuffer = await ctx.decodeAudioData(arrayBuffer)
      return scoreAudioBuffer
    } catch (e) {
      console.warn("Could not load score audio buffer for Web Audio:", e)
      return null
    } finally {
      isScoreAudioLoading = false
    }
  }

  async function loadBlockAudioBuffer() {
    if (blockAudioBuffer || isBlockAudioLoading) return blockAudioBuffer
    const ctx = getAudioContext()
    if (!ctx) return null
    isBlockAudioLoading = true
    try {
      const response = await fetch("sounds/block.mp3")
      const arrayBuffer = await response.arrayBuffer()
      blockAudioBuffer = await ctx.decodeAudioData(arrayBuffer)
      return blockAudioBuffer
    } catch (e) {
      console.warn("Could not load block audio buffer for Web Audio:", e)
      return null
    } finally {
      isBlockAudioLoading = false
    }
  }

  // Unlock Web Audio context and preload sounds on first user interaction
  const unlockAudioContext = () => {
    getAudioContext()
    loadScoreAudioBuffer()
    loadBlockAudioBuffer()
    window.removeEventListener("pointerdown", unlockAudioContext)
    window.removeEventListener("keydown", unlockAudioContext)
  }
  window.addEventListener("pointerdown", unlockAudioContext, { once: true })
  window.addEventListener("keydown", unlockAudioContext, { once: true })

  const playerRadii = [
    "var(--radius-drawn-1)",
    "var(--radius-drawn-2)",
    "var(--radius-drawn-3)",
    "var(--radius-drawn-4)",
    "var(--radius-drawn-5)",
    "var(--radius-drawn-6)",
  ]

  // --- API KEY MANAGEMENT ---

  const apiKeyInput = document.getElementById("elevenlabs-api-key")
  const saveApiKeyBtn = document.getElementById("save-api-key-btn")
  const apiKeyStatus = document.getElementById("api-key-status")
  let userApiKey = ""

  // 1. On page load, try to get the key from localStorage
  const savedKey = localStorage.getItem("elevenlabs_api_key")
  if (savedKey) {
    userApiKey = savedKey
    apiKeyInput.value = userApiKey
  }

  // 2. Click handler to save and verify ElevenLabs API Key
  if (saveApiKeyBtn) {
    saveApiKeyBtn.addEventListener("click", async () => {
      const key = apiKeyInput.value.trim()

      if (!key) {
        localStorage.removeItem("elevenlabs_api_key")
        window.SharedClassSync?.setSharedApiKey?.("")
        userApiKey = ""
        if (apiKeyStatus) {
          apiKeyStatus.textContent = "API Key cleared."
          apiKeyStatus.className = "api-status-msg success"
        }
        resetCachedTurnVoices()
        return
      }

      if (apiKeyStatus) {
        apiKeyStatus.textContent = "Verifying..."
        apiKeyStatus.className = "api-status-msg"
      }
      saveApiKeyBtn.disabled = true

      try {
        const response = await fetch("https://api.elevenlabs.io/v1/voices", {
          headers: {
            "xi-api-key": key
          }
        })

        if (response.ok) {
          localStorage.setItem("elevenlabs_api_key", key)
          window.SharedClassSync?.setSharedApiKey?.(key)
          userApiKey = key
          if (apiKeyStatus) {
            apiKeyStatus.textContent = "Key verified & saved!"
            apiKeyStatus.className = "api-status-msg success"
          }
          resetCachedTurnVoices()
          precachePlayerTurnAudios()
        } else {
          throw new Error("Invalid API key")
        }
      } catch (err) {
        console.error("ElevenLabs verification failed:", err)
        if (apiKeyStatus) {
          apiKeyStatus.textContent = "Failed. Invalid key or network error."
          apiKeyStatus.className = "api-status-msg error"
        }
      } finally {
        saveApiKeyBtn.disabled = false
      }
    })
  }

  // --- UPSTASH REDIS SYNC MANAGEMENT ---

  // Get Upstash Redis credentials from localStorage, cleaning the URL
  function getUpstashCredentials() {
    let url = localStorage.getItem(UPSTASH_URL_KEY)
    const token = localStorage.getItem(UPSTASH_TOKEN_KEY)
    if (url && url.endsWith("/")) {
      url = url.slice(0, -1)
    }
    return { url, token }
  }

  function handleUpstashError(errorMessage) {
    localStorage.removeItem(UPSTASH_URL_KEY)
    localStorage.removeItem(UPSTASH_TOKEN_KEY)
    window.SharedClassSync?.clearCredentials?.()
    
    const statusEl = document.getElementById("sync-status")
    if (statusEl) {
      statusEl.textContent = errorMessage || "Sync credentials invalid. Cleared."
      statusEl.className = "sync-status-msg error"
    }
    
    if (typeof updateSyncFieldVisibility === "function") {
      updateSyncFieldVisibility()
    }
  }

  // Helper to push a key-value pair to Upstash Redis
  async function syncToUpstash(key, data) {
    const { url, token } = getUpstashCredentials()
    if (!url || !token) return;

    try {
      const response = await fetch(`${url}/set/${key}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(data)
      })
      if (!response.ok) {
        console.error(`Upstash Sync failed for ${key}:`, response.statusText)
        if (response.status === 401 || response.status === 403) {
          handleUpstashError("Upstash token is invalid or expired. Disconnected.")
        }
      }
    } catch (error) {
      console.error(`Upstash Sync error for ${key}:`, error)
    }
  }

  // Fetch a single key from Upstash Redis
  async function fetchFromUpstash(key) {
    const { url, token } = getUpstashCredentials()
    if (!url || !token) return null;

    try {
      const response = await fetch(`${url}/get/${key}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      })
      if (response.ok) {
        const resData = await response.json()
        if (resData && resData.result !== undefined && resData.result !== null) {
          return JSON.parse(resData.result)
        }
      } else {
        console.error(`Upstash fetch failed for ${key}:`, response.statusText)
        if (response.status === 401 || response.status === 403) {
          handleUpstashError("Upstash token is invalid or expired. Disconnected.")
        }
      }
    } catch (error) {
      console.error(`Upstash fetch error for ${key}:`, error)
    }
    return null;
  }

  // Perform full sync (pull database updates and merge/overwrite local storage)
  async function syncWithUpstashOnLoad() {
    const { url, token } = getUpstashCredentials()
    if (!url || !token) return;

    const statusEl = document.getElementById("sync-status")
    if (statusEl) {
      statusEl.textContent = "Syncing..."
      statusEl.className = "sync-status-msg"
    }

    try {
      let activeClassMatch = null
      if (typeof window.SharedClassSync !== "undefined") {
        const { playerSets, classProfiles } = await window.SharedClassSync.loadAllClasses()
        if (typeof populateSetsDialog === "function") populateSetsDialog()
        activeClassMatch = window.SharedClassSync.findActiveScheduledClass(classProfiles)
      } else {
        // 1. Sync sets (Database is source of truth if it exists)
        const dbSets = await fetchFromUpstash(SHARED_SETS_KEY)
        if (!localStorage.getItem(UPSTASH_URL_KEY)) return

        if (dbSets) {
          localStorage.setItem(SHARED_SETS_KEY, JSON.stringify(dbSets))
          if (typeof populateSetsDialog === "function") populateSetsDialog()
        } else {
          // If cloud is empty but we have local sets, initialize the cloud
          const localSets = getPlayerSets()
          if (Object.keys(localSets).length > 0) {
            await syncToUpstash(SHARED_SETS_KEY, localSets)
          }
        }
      }

      // Priority 1: Scheduled active class in session right now (unless explicit URL parameters are present)
      const urlParams = new URLSearchParams(window.location.search)
      const hasExplicitUrlParams = urlParams.has("units") || urlParams.has("series") || urlParams.has("book")
      if (activeClassMatch && !hasExplicitUrlParams) {
        handleLoadSet(activeClassMatch.className, true)
      } else if (!activeClassMatch) {
        // Priority 2: Outside class hours, fall back to active session players
        const dbActive = await fetchFromUpstash(SHARED_ACTIVE_PLAYERS_KEY)
        if (!localStorage.getItem(UPSTASH_URL_KEY)) return

        if (dbActive && Array.isArray(dbActive)) {
          localStorage.setItem(SHARED_ACTIVE_PLAYERS_KEY, JSON.stringify(dbActive))
          loadSettings()
          renderNameInputs()
          validatePlayerNames()
        } else {
          const localActiveJSON = localStorage.getItem(SHARED_ACTIVE_PLAYERS_KEY)
          if (localActiveJSON) {
            try {
              const localActive = JSON.parse(localActiveJSON)
              if (Array.isArray(localActive) && localActive.length > 0) {
                await syncToUpstash(SHARED_ACTIVE_PLAYERS_KEY, localActive)
              }
            } catch (e) {
              console.error(e)
            }
          }
        }
      }

      if (statusEl) {
        statusEl.textContent = "Synced successfully!"
        statusEl.className = "sync-status-msg success"
      }
    } catch (err) {
      console.error("Error running onload sync:", err)
      if (statusEl) {
        statusEl.textContent = "Sync failed."
        statusEl.className = "sync-status-msg error"
      }
    }
  }

  // --- DOM ELEMENTS ---

  const setupView = document.getElementById("game-setup")
  const gameView = document.getElementById("game-view")
  const playerInfoList = document.getElementById("player-info-list")
  const gameBoard = document.getElementById("game-board")
  const gameControls = document.getElementById("game-controls")
  const playerNamesContainer = document.getElementById("player-names-container")
  const addPlayerBtn = document.getElementById("addPlayerBtn")
  const gridSizeInput = document.getElementById("gridSize")
  const gridSizeValue = document.getElementById("gridSizeValue")
  const matchLengthInput = document.getElementById("matchLength")
  const unitLevelTabs = document.getElementById("unit-level-tabs")
  const activeLevelToolbar = document.getElementById("active-level-toolbar")
  const activeLevelTitle = document.getElementById("active-level-title")
  const toggleLevelAllBtn = document.getElementById("toggle-level-all-btn")
  const unitChipsGrid = document.getElementById("unit-chips-grid")
  const bookSelect = document.getElementById("book-select")
  let activeSeriesId = "smart-phonics"
  let selectedUnitKeys = new Set()
  let currentActiveLevelKey = "level1"
  const startGameBtn = document.getElementById("startGameBtn")
  const gameDialog = document.getElementById("game-over-dialog")
  const muteSoundsToggle = document.getElementById("muteSoundsToggle")
  const resetGameBtn = document.getElementById("resetGameBtn")
  const backToSettingsBtn = document.getElementById("settings-btn")
  const playAgainBtn = document.getElementById("play-again-btn")
  const closeDialogBtn = document.getElementById("close-dialog-btn")
  const pronounceWordsToggle = document.getElementById("pronounceWordsToggle")
  const gameModeSelector = document.getElementById("gameModeSelector")
  const randomizeGameModeBtn = document.getElementById("randomizeGameModeBtn")
  const survivorOptionsGroup =
    document.getElementById("survivorOptionsGroup") ||
    document.getElementById("fairPlaySettingGroup")
  const survivorRotatingStarterToggle = document.getElementById(
    "survivorRotatingStarterToggle",
  )
  const survivorEqualRoundsToggle = document.getElementById(
    "survivorEqualRoundsToggle",
  )
  const fairPlaySettingGroup = survivorOptionsGroup
  const fairPlayToggle = survivorEqualRoundsToggle
  const conquestOptionsGroup = document.getElementById("conquestOptionsGroup")
  const conquestBlockPointsToggle = document.getElementById(
    "conquestBlockPointsToggle",
  )
  const conquestRotatingStarterToggle = document.getElementById(
    "conquestRotatingStarterToggle",
  )
  const conquestEqualRoundsToggle = document.getElementById(
    "conquestEqualRoundsToggle",
  )
  const stealthOptionsGroup = document.getElementById("stealthOptionsGroup")
  const stealthRotatingStarterToggle = document.getElementById(
    "stealthRotatingStarterToggle",
  )
  const stealthEqualRoundsToggle = document.getElementById(
    "stealthEqualRoundsToggle",
  )
  const gameModeHint = document.getElementById("gameModeHint")
  const gameModeTooltipKo = document.getElementById("game-mode-tooltip-ko")
  const modeRulesPanel = document.getElementById("modeRulesPanel")
  const resetSettingsBtn = document.getElementById("resetSettingsBtn")
  const randomizePlayerOrderBtn_setup = document.getElementById(
    "randomizePlayerOrderBtn_setup",
  )
  const manageSetsBtn = document.getElementById("manage-sets-btn")
  const playerSetsDialog = document.getElementById("player-sets-dialog")
  const savedSetsList = document.getElementById("saved-sets-list")
  const saveSetNameInput = document.getElementById("save-set-name-input")
  const saveSetBtn = document.getElementById("save-set-btn")
  const closeSetsDialogBtn = document.getElementById("close-sets-dialog-btn")
  const resetUnitsBtn = document.getElementById("reset-units-btn")
  const manageBooksBtn = document.getElementById("manage-books-btn")
  const manageBooksDialog = document.getElementById("manage-books-dialog")
  const closeManageBooksBtn = document.getElementById("close-manage-books-btn")
  const doneManageBooksBtn = document.getElementById("done-manage-books-btn")
  const manageBooksList = document.getElementById("manage-books-list")
  const statsView = document.getElementById("stats-view")
  const showStatsBtn = document.getElementById("show-stats-btn")
  const backToSetupBtn = document.getElementById("back-to-setup-btn")
  const statsPlayerSelect = document.getElementById("stats-player-select")
  const statsDisplayArea = document.getElementById("stats-display-area")
  const feedbackSnackbar = document.getElementById("feedback-snackbar")
  const snackbarMessage = document.getElementById("snackbar-message")
  const randomizeBoardSizeBtn = document.getElementById("randomizeBoardSizeBtn")
  let userSetConquestRotatingStarters = false
  let userSetStealthRotatingStarters = false
  let userSetSurvivorRotatingStarters = false
  let userSetConquestEqualRounds = false
  let userSetStealthEqualRounds = false
  let userSetSurvivorEqualRounds = false

  // --- EVENT HANDLER FUNCTIONS ---

  const handleCloseDialog = () => {
    gameDialog.close()
  }

  const handleReset = () => enterReorderMode()

  const handlePlayAgain = () => {
    gameDialog.close()
    enterReorderMode()
  }
  const handleKeydown = (e) => {
    if (e.key === "Backspace") {
      undoLastMove()
    }
  }

  const handleBackToSettings = () => {
    removeGameEventListeners()
    isOrderLocked = false

    stopAllTurnVoices()
    if (pendingTurnAnnouncementTimeout) {
      clearTimeout(pendingTurnAnnouncementTimeout)
      pendingTurnAnnouncementTimeout = null
    }

    // Rebuild the .setup.players object from the previous game's players, preserving colorIndex
    const playersFromLastGame =
      gameState.players && gameState.players.length > 0
        ? gameState.players.map((p, index) => ({
            id: Date.now() + index,
            name: p.name || gameState.playerNames[index],
            colorIndex: p.colorIndex,
          }))
        : gameState.playerNames.map((name, index) => ({
            id: Date.now() + index,
            name: name,
          }))

    // Reset the gameState to the initial structure, preserving players and colors
    gameState = {
      ...gameState, // Carry over settings like gridSize, etc.
      currentView: "setup",
      setup: {
        players: assignRandomColors(playersFromLastGame, false),
      },
    }

    renderNameInputs()
    updatePlayerButtonsState()
    validatePlayerNames()
    populatePlayerDatalist()
    saveSettings()
    render()
  }

  function handleRandomizeBoardSize() {
    const min = parseInt(gridSizeInput.min, 10)
    const max = parseInt(gridSizeInput.max, 10)

    // Ensure the new random size is different from the current one, if possible
    let newSize
    const currentSize = parseInt(gridSizeInput.value, 10)
    if (min === max) {
      newSize = min
    } else {
      do {
        newSize = Math.floor(Math.random() * (max - min + 1)) + min
      } while (newSize === currentSize)
    }

    gridSizeInput.value = newSize
    syncSliders()
    saveSettings()
    playSound("click")
  }

  // --- EVENT LISTENER MANAGEMENT ---

  function addGameEventListeners() {
    if (areGameEventListenersAttached) return

    resetGameBtn.addEventListener("click", handleReset)
    backToSettingsBtn.addEventListener("click", handleBackToSettings)
    playAgainBtn.addEventListener("click", handlePlayAgain)
    closeDialogBtn.addEventListener("click", handleCloseDialog)
    document.addEventListener("keydown", handleKeydown)

    areGameEventListenersAttached = true
  }

  function removeGameEventListeners() {
    if (!areGameEventListenersAttached) return

    resetGameBtn.removeEventListener("click", handleReset)
    backToSettingsBtn.removeEventListener("click", handleBackToSettings)
    playAgainBtn.removeEventListener("click", handlePlayAgain)
    closeDialogBtn.removeEventListener("click", handleCloseDialog)
    document.removeEventListener("keydown", handleKeydown)

    areGameEventListenersAttached = false
  }

  // --- MAIN RENDER FUNCTION ---

  function render() {
    renderViews()

    if (gameState.currentView === "stats") {
      renderStatsView()
    } else if (
      gameState.currentView === "reorder" ||
      gameState.currentView === "game"
    ) {
      renderPlayerInfo()
      renderBoard()
      if (gameState.currentView === "game") {
        renderWinLines()
      }
    }
  }

  function renderViews() {
    const { currentView } = gameState

    setupView.classList.toggle("is-active", currentView === "setup")
    statsView.classList.toggle("is-active", currentView === "stats")
    gameView.classList.toggle(
      "is-active",
      currentView === "reorder" || currentView === "game",
    )

    // Add/remove a class to the game view itself to control reorder UI
    gameView.classList.toggle("reorder-active", currentView === "reorder")

    const reorderControls = document.getElementById("reorder-controls")
    if (reorderControls) {
      reorderControls.classList.toggle("hidden", currentView !== "reorder")
    }

    // The rest of the logic remains similar but simplified
    playerInfoList.classList.toggle(
      "hidden",
      currentView !== "reorder" && currentView !== "game",
    )
    gameBoard.classList.toggle(
      "hidden",
      currentView !== "reorder" && currentView !== "game",
    )
    gameControls.classList.toggle(
      "hidden",
      currentView !== "reorder" && currentView !== "game",
    )
  }

  // --- RENDERING SUB-FUNCTIONS ---

  function adjustCellWordFontSize() {
    if (!gameBoard) return

    const firstCell = gameBoard.querySelector(".cell")
    if (!firstCell) return

    // Temporarily reset size to let the grid/cells shrink to their allocated layout sizes
    const oldSize = gameBoard.style.getPropertyValue("--dynamic-word-size")
    gameBoard.style.setProperty("--dynamic-word-size", "10px")

    // Measure cell dimensions at minimum size
    const cellWidth = firstCell.clientWidth
    const cellHeight = firstCell.clientHeight

    // Restore old size
    if (oldSize) {
      gameBoard.style.setProperty("--dynamic-word-size", oldSize)
    } else {
      gameBoard.style.removeProperty("--dynamic-word-size")
    }

    const cells = Array.from(gameBoard.querySelectorAll(".cell"))
    if (cells.length === 0) return

    const maxWidth = Math.max(10, cellWidth - 16)
    const maxHeight = Math.max(10, cellHeight - 20)

    const ABSOLUTE_MAX_FONT_SIZE = 72
    let minFontSize = 10
    let maxFontSize = Math.min(maxHeight, ABSOLUTE_MAX_FONT_SIZE)
    if (maxFontSize < minFontSize) maxFontSize = minFontSize

    let optimalSize = minFontSize

    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")

    while (minFontSize <= maxFontSize) {
      const midSize = Math.floor((minFontSize + maxFontSize) / 2)
      context.font = `700 ${midSize}px "Parkinsans", sans-serif`

      let allFit = true
      for (const cell of cells) {
        const text = cell.textContent.trim()
        const metrics = context.measureText(text)
        
        if (metrics.width > maxWidth || midSize > maxHeight) {
          allFit = false
          break
        }
      }

      if (allFit) {
        optimalSize = midSize
        minFontSize = midSize + 1
      } else {
        maxFontSize = midSize - 1
      }
    }

    gameBoard.style.setProperty("--dynamic-word-size", `${optimalSize}px`)
  }

  function renderBoard() {
    gameBoard.style.gridTemplateColumns = `repeat(${gameState.gridSize}, minmax(0, 1fr))`
    const newTotalCells = gameState.gridSize * gameState.gridSize

    // Clean up cells from a previously larger grid
    const allCurrentCells = gameBoard.querySelectorAll(".cell")
    allCurrentCells.forEach((cell) => {
      if (parseInt(cell.dataset.index, 10) >= newTotalCells) {
        cell.remove()
      }
    })

    // Main render loop
    for (let i = 0; i < newTotalCells; i++) {
      let cell = gameBoard.querySelector(`[data-index='${i}']`)

      if (!cell) {
        cell = document.createElement("button")
        cell.classList.add("button", "cell")
        cell.dataset.index = i
        cell.addEventListener("click", handleCellClick)
        gameBoard.appendChild(cell)
      }

      const wordObject = wordCache[i] || { word: "?", target: "" }
      const newHTML = highlightTargetSounds(wordObject.word, wordObject.target)
      // Only update innerHTML if it has actually changed
      if (cell.innerHTML !== newHTML) {
        cell.innerHTML = newHTML
      }

      const cellState = gameState.board[i]
      const shouldBeDisabled = cellState !== null
      // Only update the disabled property if it has changed
      if (cell.disabled !== shouldBeDisabled) {
        cell.disabled = shouldBeDisabled
      }

      const newSymbol = shouldBeDisabled ? playerSymbols[cellState] : null
      // Only update the data-player-symbol if it has changed
      if (cell.dataset.playerSymbol !== newSymbol) {
        if (newSymbol) {
          cell.dataset.playerSymbol = newSymbol
          cell.style.setProperty(
            "--player-color",
            gameState.playerColors[cellState],
          )
        } else {
          cell.removeAttribute("data-player-symbol")
          cell.style.removeProperty("--player-color")
        }
      }

      const shouldBeHighlighted = gameState.highlightedCells.has(i)
      // Only update the highlight class if it has changed
      if (cell.classList.contains("highlight") !== shouldBeHighlighted) {
        cell.classList.toggle("highlight", shouldBeHighlighted)
      }

      cell.classList.toggle("corner-tl", i === 0)
      cell.classList.toggle("corner-tr", i === gameState.gridSize - 1)
      cell.classList.toggle("corner-bl", i === gameState.gridSize * (gameState.gridSize - 1))
      cell.classList.toggle("corner-br", i === newTotalCells - 1)
    }

    const firstCell = gameBoard.querySelector(".cell")
    if (firstCell) {
      requestAnimationFrame(() => {
        adjustCellWordFontSize()
      })
    }
  }

  function getCurrentRoundOrder() {
    if (gameState.currentView === "reorder") {
      return Array.from({ length: gameState.numPlayers }, (_, i) => i)
    }
    if (
      gameState.gameMode === "Conquest" &&
      gameState.conquestRotatingStarters &&
      Array.isArray(gameState.conquestRoundOrder) &&
      gameState.conquestRoundOrder.length === gameState.numPlayers
    ) {
      return gameState.conquestRoundOrder
    }
    if (
      gameState.gameMode === "Stealth" &&
      gameState.stealthRotatingStarters &&
      Array.isArray(gameState.stealthRoundOrder) &&
      gameState.stealthRoundOrder.length === gameState.numPlayers
    ) {
      return gameState.stealthRoundOrder
    }
    if (
      gameState.gameMode === "Survivor" &&
      gameState.survivorRotatingStarters &&
      Array.isArray(gameState.survivorRoundOrder)
    ) {
      const active = gameState.survivorRoundOrder
      const rest = []
      for (let i = 0; i < gameState.numPlayers; i++) {
        if (!active.includes(i)) rest.push(i)
      }
      return [...active, ...rest]
    }
    return Array.from({ length: gameState.numPlayers }, (_, i) => i)
  }

  function renderPlayerInfo() {
    const {
      playerNames,
      scores,
      currentPlayer,
      playerColors,
      playerRadii,
      eliminatedPlayers,
      currentView,
      numPlayers,
    } = gameState

    if (!playerNames || playerNames.length === 0) return

    const isReordering = currentView === "reorder"
    const order = getCurrentRoundOrder()

    // 1. Check if the order changed and measure FIRST rects
    const currentBlocks = Array.from(
      playerInfoList.querySelectorAll(".player-info-block"),
    )
    const currentDomOrder = currentBlocks.map((el) =>
      parseInt(el.dataset.index, 10),
    )
    const orderChanged =
      !isReordering &&
      currentView === "game" &&
      currentDomOrder.length === order.length &&
      currentDomOrder.some((pIndex, idx) => pIndex !== order[idx])

    const firstRects = new Map()
    if (orderChanged) {
      currentBlocks.forEach((el) => {
        const pIndex = parseInt(el.dataset.index, 10)
        firstRects.set(pIndex, el.getBoundingClientRect())
      })
    }

    // 2. Ensure each card exists and update its state in target order
    order.forEach((i) => {
      let playerBlock = document.getElementById(`player-info-block-${i}`)
      if (!playerBlock) {
        playerBlock = document.createElement("div")
        playerBlock.id = `player-info-block-${i}`
        playerBlock.className = "card outlined player-info-block"
        playerBlock.classList.add("badge")
        playerBlock.innerHTML = `
          <hgroup><h3 data-role="name"></h3></hgroup>
          <div class="content" data-role="score"></div>
        `
      }

      playerBlock.dataset.index = i
      playerBlock.setAttribute("aria-label", playerSymbols[i])

      const nameEl = playerBlock.querySelector('[data-role="name"]')
      if (nameEl) nameEl.textContent = playerNames[i]
      const scoreEl = playerBlock.querySelector('[data-role="score"]')
      if (scoreEl) scoreEl.textContent = scores[i]

      playerBlock.style.setProperty("--player-color", playerColors[i])
      if (playerRadii && playerRadii[i]) {
        playerBlock.style.borderRadius = playerRadii[i]
      }

      playerBlock.classList.toggle(
        "current-player",
        i === currentPlayer && !isReordering,
      )
      playerBlock.classList.toggle("eliminated", eliminatedPlayers?.includes(i))

      const isCurrentActivePlayer = i === currentPlayer && !isReordering
      if (isReordering) {
        playerBlock.draggable = true
        playerBlock.removeAttribute("tabindex")
        playerBlock.removeAttribute("role")
        playerBlock.removeEventListener("dragstart", handleDragStart)
        playerBlock.removeEventListener("dragend", handleDragEnd)
        playerBlock.addEventListener("dragstart", handleDragStart)
        playerBlock.addEventListener("dragend", handleDragEnd)
      } else {
        playerBlock.draggable = false
        if (isCurrentActivePlayer) {
          playerBlock.tabIndex = 0
          playerBlock.setAttribute("role", "button")
        } else {
          playerBlock.removeAttribute("tabindex")
          playerBlock.removeAttribute("role")
        }
      }

      playerInfoList.appendChild(playerBlock)
    })

    // Clean up any extraneous blocks (e.g. if player count decreased)
    Array.from(playerInfoList.children).forEach((child) => {
      const pIndex = parseInt(child.dataset.index, 10)
      if (!order.includes(pIndex)) {
        child.remove()
      }
    })

    // 3. FLIP Play: if order changed, invert with translate and smoothly animate to new positions!
    if (orderChanged && firstRects.size > 0) {
      playerInfoList.querySelectorAll(".player-info-block").forEach((el) => {
        const pIndex = parseInt(el.dataset.index, 10)
        const firstRect = firstRects.get(pIndex)
        if (!firstRect) return

        const lastRect = el.getBoundingClientRect()
        const deltaX = firstRect.left - lastRect.left
        const deltaY = firstRect.top - lastRect.top

        if (deltaX !== 0 || deltaY !== 0) {
          el.classList.add("sliding")
          el.style.transition = "none"
          el.style.translate = `${deltaX}px ${deltaY}px`

          void el.offsetHeight // Force layout reflow

          requestAnimationFrame(() => {
            el.style.transition =
              "translate 0.6s var(--ease-out-3, cubic-bezier(0, 0, 0, 1))"
            el.style.translate = ""
            setTimeout(() => {
              el.classList.remove("sliding")
              el.style.transition = ""
            }, 600)
          })
        }
      })
    }
  }

  function renderWinLines() {
    const existingLines = new Set(
      Array.from(gameBoard.querySelectorAll(".strike-through-line")).map(
        (el) => el.id,
      ),
    )
    const requiredLines = new Set(
      gameState.winLinesToDraw.map((line) => line.id),
    )

    // Remove lines that are in the DOM but not in the state
    existingLines.forEach((lineId) => {
      if (!requiredLines.has(lineId)) {
        document.getElementById(lineId)?.remove()
      }
    })

    // Add lines that are in the state but not in the DOM
    gameState.winLinesToDraw.forEach((lineData) => {
      if (!existingLines.has(lineData.id)) {
        const startCell = gameBoard.querySelector(
          `[data-index='${lineData.start}']`,
        )
        const endCell = gameBoard.querySelector(
          `[data-index='${lineData.end}']`,
        )
        if (startCell && endCell) {
          const lineElement = drawLine(startCell, endCell, lineData.color)
          lineElement.id = lineData.id
        }
      }
    })
  }

  function showFloatingPoints(targetCell, text, color) {
    if (!targetCell) return

    const rect = targetCell.getBoundingClientRect()
    const popup = document.createElement("div")
    popup.className = "points-popup"
    popup.textContent = text
    if (color) {
      popup.style.setProperty("--player-color", color)
    }

    popup.style.left = `${rect.left + rect.width / 2}px`
    popup.style.top = `${rect.top + rect.height / 3}px`

    document.body.appendChild(popup)

    popup.addEventListener("animationend", () => popup.remove(), { once: true })
    setTimeout(() => popup.remove(), 2500)
  }

  function renderStatsView() {
    const stats = getStats()
    const playerIds = Object.keys(stats)

    statsPlayerSelect.innerHTML = ""
    if (playerIds.length === 0) {
      const option = document.createElement("option")
      option.textContent = "-- No stats saved --"
      statsPlayerSelect.appendChild(option)
      statsDisplayArea.innerHTML =
        "<p class='field-hint'>Play a game to see stats here!</p>"
      return
    }

    // Populate the player selection dropdown, sorting names alphabetically
    const sortedPlayerOptions = playerIds
      .map((id) => ({ id, name: stats[id].name }))
      .sort((a, b) => a.name.localeCompare(b.name))

    sortedPlayerOptions.forEach((player) => {
      const option = document.createElement("option")
      option.value = player.id
      option.textContent = player.name
      statsPlayerSelect.appendChild(option)
    })

    const displayStatsForPlayer = (playerId) => {
      const playerData = stats[playerId]
      if (!playerData) {
        statsDisplayArea.innerHTML = ""
        return
      }

      let nemesisName = "N/A"
      let maxLosses = 0
      if (playerData.nemesis) {
        for (const name in playerData.nemesis) {
          if (playerData.nemesis[name] > maxLosses) {
            maxLosses = playerData.nemesis[name]
            nemesisName = name
          }
        }
      }
      const nemesisDisplay =
        maxLosses > 0 ? `${nemesisName} (${maxLosses} losses)` : "N/A"

      // --- Function to build config-specific stats tables ---
      const buildConfigTable = (configs, mode) => {
        if (Object.keys(configs).length === 0)
          return "<p class='field-hint'>No games played in this configuration.</p>"

        let tableHTML =
          "<table><thead><tr><th>Board Config</th><th>" +
          (mode === "Stealth" ? "Best Score (Low)" : "High Score") +
          "</th><th>Avg. Points</th></tr></thead><tbody>"
        for (const key in configs) {
          const configData = configs[key]
          const avgPoints =
            configData.gamesPlayed > 0
              ? (configData.totalPoints / configData.gamesPlayed).toFixed(1)
              : 0
          const scoreToDisplay =
            mode === "Stealth" ? configData.bestScore : configData.highScore
          tableHTML += `<tr><td>${key}</td><td>${
            scoreToDisplay ?? "N/A"
          }</td><td>${avgPoints}</td></tr>`
        }
        tableHTML += "</tbody></table>"
        return tableHTML
      }

      statsDisplayArea.innerHTML = `
      <div class="stats-section">
        <h4 class="h5">Overall Stats</h4>
        <ul class="definition-list">
          <li><span class="term">Win Percentage</span><hr><span class="description">${
            playerData.gamesPlayed > 0
              ? ((playerData.wins / playerData.gamesPlayed) * 100).toFixed(0)
              : 0
          }%</span></li>
          <li><span class="term">Games Won</span><hr><span class="description">${
            playerData.wins
          } of ${playerData.gamesPlayed}</span></li>
          <li><span class="term">Longest Win Streak</span><hr><span class="description">${
            playerData.longestWinStreak
          }</span></li>
          <li><span class="term">Nemesis</span><hr><span class="description">${nemesisDisplay}</span></li>
        </ul>
      </div>

      <div class="stats-section">
        <h4 class="h5">Conquest Mode</h4>
        <ul class="definition-list">
          <li><span class="term">Win %</span><hr><span class="description">${
            playerData.modes.conquest.gamesPlayed > 0
              ? (
                  (playerData.modes.conquest.wins /
                    playerData.modes.conquest.gamesPlayed) *
                  100
                ).toFixed(0)
              : 0
          }%</span></li>
          <li><span class="term">Total Blocks</span><hr><span class="description">${
            playerData.modes.conquest.totalBlocks
          }</span></li>
          <li><span class="term">Multi-Line Scores (2/3/4/5/6+)</span><hr><span class="description">${Object.values(
            playerData.modes.conquest.multiLineScoreCounts,
          ).join(" / ")}</span></li>
        </ul>
        ${buildConfigTable(playerData.modes.conquest.configs, "Conquest")}
      </div>
      
      <div class="stats-section">
        <h4 class="h5">Stealth Mode</h4>
        <ul class="definition-list">
          <li><span class="term">Win %</span><hr><span class="description">${
            playerData.modes.stealth.gamesPlayed > 0
              ? (
                  (playerData.modes.stealth.wins /
                    playerData.modes.stealth.gamesPlayed) *
                  100
                ).toFixed(0)
              : 0
          }%</span></li>
          <li><span class="term">"Perfect Stealth" Games</span><hr><span class="description">${
            playerData.modes.stealth.perfectStealthGames
          }</span></li>
        </ul>
        ${buildConfigTable(playerData.modes.stealth.configs, "Stealth")}
      </div>
      
      <div class="stats-section">
        <h4 class="h5">Classic Mode</h4>
        <ul class="definition-list">
           <li><span class="term">Win %</span><hr><span class="description">${
             playerData.modes.classic.gamesPlayed > 0
               ? (
                   (playerData.modes.classic.wins /
                     playerData.modes.classic.gamesPlayed) *
                   100
                 ).toFixed(0)
               : 0
           }%</span></li>
           <li><span class="term">Quickest Win</span><hr><span class="description">${
             playerData.modes.classic.quickestWin !== null
               ? `${playerData.modes.classic.quickestWin} turns`
               : "N/A"
           }</span></li>
           <li><span class="term">Total Blocks</span><hr><span class="description">${
             playerData.modes.classic.totalBlocks
           }</span></li>
        </ul>
      </div>
      
      <div class="stats-section">
        <h4 class="h5">Survivor Mode</h4>
        <ul class="definition-list">
           <li><span class="term">Win %</span><hr><span class="description">${
             playerData.modes.survivor.gamesPlayed > 0
               ? (
                   (playerData.modes.survivor.wins /
                     playerData.modes.survivor.gamesPlayed) *
                   100
                 ).toFixed(0)
               : 0
           }%</span></li>
          <li><span class="term">Avg. Finishing Place</span><hr><span class="description">${
            playerData.modes.survivor.gamesFinished > 0
              ? (
                  playerData.modes.survivor.totalSurvivalRank /
                  playerData.modes.survivor.gamesFinished
                ).toFixed(2)
              : "N/A"
          }</span></li>
           <li><span class="term">Total Blocks</span><hr><span class="description">${
             playerData.modes.survivor.totalBlocks
           }</span></li>
        </ul>
      </div>
    `
    }

    statsPlayerSelect.addEventListener("change", (e) => {
      displayStatsForPlayer(e.target.value)
    })

    if (sortedPlayerOptions.length > 0) {
      displayStatsForPlayer(sortedPlayerOptions[0].id)
    }
  }

  // --- LOGIC / STATE MANAGEMENT FUNCTIONS ---

  async function handleCellClick(event) {
    if (gameState.currentView === "reorder") {
      if (gameState.currentPlayer === 0) {
        initGame(false)
      } else {
        return
      }
    }

    if (!isOrderLocked || isMoveProcessing) return
    const cell = event.target.closest(".cell")
    if (!cell || cell.disabled) return

    const index = parseInt(cell.dataset.index)

    // Silence active turn announcement and prevent any pending ones
    currentTurnCellClicked = true
    stopAllTurnVoices()
    if (pendingTurnAnnouncementTimeout) {
      clearTimeout(pendingTurnAnnouncementTimeout)
      pendingTurnAnnouncementTimeout = null
    }

    // Play click feedback immediately on tap
    playSound("click")

    // If word pronunciation is enabled, show visual indicator and wait for audio to finish
    if (gameState.pronounceWords) {
      isMoveProcessing = true
      if (gameBoard) gameBoard.classList.add("processing-move")
      const activePlayerColor = gameState.playerColors[gameState.currentPlayer]
      cell.style.setProperty("--active-player-color", activePlayerColor)
      cell.classList.add("pronouncing")

      try {
        await speak(cell.textContent)
        // Brief breath delay before transition (allows user to absorb pronunciation)
        await new Promise((resolve) => setTimeout(resolve, 150))
      } catch (e) {
        console.error("Error pronouncing word:", e)
      } finally {
        cell.classList.remove("pronouncing")
        cell.style.removeProperty("--active-player-color")
        if (gameBoard) gameBoard.classList.remove("processing-move")
        isMoveProcessing = false
      }
    }

    // Call the core game logic (skip redundant click sound since click already played on tap)
    const { isGameOver, soundPromise, pointsScored, blockPoints } =
      processPlayerMove(index, true)

    // Render the result of the move (now cell receives player's symbol and color)
    render()

    // Show floating points popup when points are scored
    if (gameState.gameMode !== "Survivor") {
      const scoringPlayerColor =
        gameState.playerColors[gameState.board[index]] ||
        gameState.playerColors[gameState.currentPlayer]
      if (pointsScored > 0) {
        showFloatingPoints(cell, `+${pointsScored}`, scoringPlayerColor)
      } else if (blockPoints > 0) {
        showFloatingPoints(cell, `+${blockPoints}`, scoringPlayerColor)
      }
    }

    // Handle the end of the game after rendering
    if (isGameOver) {
      if (gameState.gameMode === "Survivor" && pointsScored > 0) {
        soundPromise.then(() => {
          endGame()
        })
      } else {
        endGame()
      }
    } else {
      // Reset turn click state for the next player
      currentTurnCellClicked = false

      // Wait for sound chimes to finish before playing next turn's announcement
      soundPromise.then(() => {
        // Double check they didn't click another cell in the meantime
        if (currentTurnCellClicked) return
        announceCurrentPlayerTurnWithDelay(500)
      })
    }
  }

  function enterReorderMode() {
    stopAllTurnVoices()
    if (pendingTurnAnnouncementTimeout) {
      clearTimeout(pendingTurnAnnouncementTimeout)
      pendingTurnAnnouncementTimeout = null
    }

    const settings = {
      players: gameState.players,
      playerNames: gameState.playerNames,
      playerColors: gameState.playerColors,
      playerRadii: gameState.playerRadii,
      numPlayers: gameState.numPlayers,
      gridSize: gameState.gridSize,
      matchLength: gameState.matchLength,
      gameMode: gameState.gameMode,
      fairPlay: gameState.fairPlay,
      survivorRotatingStarters: gameState.survivorRotatingStarters,
      survivorEqualRounds: gameState.survivorEqualRounds,
      conquestBlockPoints: gameState.conquestBlockPoints,
      conquestRotatingStarters: gameState.conquestRotatingStarters,
      conquestEqualRounds: gameState.conquestEqualRounds,
      stealthRotatingStarters: gameState.stealthRotatingStarters,
      stealthEqualRounds: gameState.stealthEqualRounds,
      selectedUnits: gameState.selectedUnits,
      pronounceWords: gameState.pronounceWords,
      isMuted: gameState.isMuted,
    }

    gameBoard
      .querySelectorAll(".strike-through-line")
      .forEach((el) => el.remove())

    gameState = {
      ...settings,
      board: Array(settings.gridSize * settings.gridSize).fill(null),
      scores: Array(settings.numPlayers).fill(0),
      currentPlayer: 0,
      movesMade: 0,
      completedLines: new Set(),
      moveHistory: [],
      highlightedCells: new Set(),
      winLinesToDraw: [],
      eliminatedPlayers: [],
      survivorRoundStarter: 0,
      survivorRoundOrder: Array.from(
        { length: settings.numPlayers },
        (_, i) => i,
      ),
      survivorTurnIndex: 0,
      eliminatedThisRound: [],
      conquestRoundStarter: 0,
      conquestRoundOrder: Array.from(
        { length: settings.numPlayers },
        (_, i) => i,
      ),
      conquestTurnIndex: 0,
      stealthRoundStarter: 0,
      stealthRoundOrder: Array.from(
        { length: settings.numPlayers },
        (_, i) => i,
      ),
      stealthTurnIndex: 0,
      playerStatsThisGame: Array(settings.numPlayers)
        .fill(null)
        .map(() => ({
          blocks: 0,
          multiLineScores: { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
        })),
      currentView: "reorder",
    }

    isOrderLocked = false

    addGameEventListeners()
    render()
  }

  function undoLastMove() {
    if (gameState.moveHistory.length === 0 || isMoveProcessing) return

    const lastMove = gameState.moveHistory[gameState.moveHistory.length - 1]

    // Revert all state properties based on the last move
    const newBoard = [...gameState.board]
    newBoard[lastMove.index] = null

    let newScores = [...gameState.scores]
    let newCompletedLines = new Set(gameState.completedLines)
    let newHighlightedCells = new Set(gameState.highlightedCells)
    let newWinLinesToDraw = [...gameState.winLinesToDraw]
    let newEliminatedPlayers = [...gameState.eliminatedPlayers]

    if (lastMove.scoredLines.length > 0) {
      newScores[lastMove.player] -= lastMove.scoredLines.length

      if (gameState.gameMode === "Survivor") {
        newEliminatedPlayers = newEliminatedPlayers.filter(
          (playerId) => playerId !== lastMove.player
        )
      }

      const remainingLines = Array.from(newCompletedLines).filter(
        (lineId) => !lastMove.scoredLines.includes(lineId),
      )
      newCompletedLines = new Set(remainingLines)

      newHighlightedCells.clear()
      remainingLines.forEach((lineId) => {
        const indices = lineId.split(",").map(Number)
        indices.forEach((index) => newHighlightedCells.add(index))
      })

      const lastMoveLineIds = new Set(
        lastMove.scoredLines.map(
          (lineId) =>
            `line-${lineId.split(",")[0]}-${
              lineId.split(",")[lineId.split(",").length - 1]
            }`,
        ),
      )

      newWinLinesToDraw = newWinLinesToDraw.filter(
        (line) => !lastMoveLineIds.has(line.id),
      )
    }

    if (lastMove.blockPoints && lastMove.blockPoints > 0) {
      newScores[lastMove.player] =
        Math.round((newScores[lastMove.player] - lastMove.blockPoints) * 10) /
        10
    }

    let survivorStateUpdates = {}
    if (lastMove.survivorState) {
      survivorStateUpdates = {
        survivorRoundStarter: lastMove.survivorState.starter,
        survivorRoundOrder: [...lastMove.survivorState.roundOrder],
        survivorTurnIndex: lastMove.survivorState.turnIndex,
        eliminatedThisRound: [...lastMove.survivorState.eliminatedThisRound],
      }
    }

    let conquestStateUpdates = {}
    if (lastMove.conquestState) {
      conquestStateUpdates = {
        conquestRoundStarter: lastMove.conquestState.starter,
        conquestRoundOrder: [...lastMove.conquestState.roundOrder],
        conquestTurnIndex: lastMove.conquestState.turnIndex,
      }
    }

    let stealthStateUpdates = {}
    if (lastMove.stealthState) {
      stealthStateUpdates = {
        stealthRoundStarter: lastMove.stealthState.starter,
        stealthRoundOrder: [...lastMove.stealthState.roundOrder],
        stealthTurnIndex: lastMove.stealthState.turnIndex,
      }
    }

    // Set the new, reverted state
    gameState = {
      ...gameState,
      board: newBoard,
      scores: newScores,
      completedLines: newCompletedLines,
      highlightedCells: newHighlightedCells,
      winLinesToDraw: newWinLinesToDraw,
      eliminatedPlayers: newEliminatedPlayers,
      movesMade: gameState.movesMade - 1,
      currentPlayer: lastMove.player,
      moveHistory: gameState.moveHistory.slice(0, -1),
      ...survivorStateUpdates,
      ...conquestStateUpdates,
      ...stealthStateUpdates,
    }

    if (feedbackSnackbar) {
      try {
        feedbackSnackbar.hidePopover()
      } catch (e) {}
    }

    render() // Re-render after state change

    // Re-announce the current player turn since it was reverted
    currentTurnCellClicked = false
    stopAllTurnVoices()
    if (pendingTurnAnnouncementTimeout) {
      clearTimeout(pendingTurnAnnouncementTimeout)
      pendingTurnAnnouncementTimeout = null
    }
    announceCurrentPlayerTurnWithDelay(500)
  }

  function applyWinningLines(lines, scoringPlayer) {
    const {
      scores,
      completedLines,
      highlightedCells,
      winLinesToDraw,
      playerColors,
    } = gameState

    const newScores = [...scores]
    const newCompletedLines = new Set(completedLines)
    const newHighlightedCells = new Set(highlightedCells)
    const newWinLinesToDraw = [...winLinesToDraw]

    newScores[scoringPlayer] += lines.length

    lines.forEach((line) => {
      const lineId = lineToString(line)
      newCompletedLines.add(lineId)

      line.forEach((cellIndex) => {
        newHighlightedCells.add(cellIndex)

        const cellToPulse = gameBoard.querySelector(
          `[data-index='${cellIndex}']`,
        )
        if (cellToPulse) {
          cellToPulse.classList.remove("pulse")
          void cellToPulse.offsetWidth
          cellToPulse.classList.add("pulse")
        }
      })

      const sortedLine = [...line].sort((a, b) => a - b)
      newWinLinesToDraw.push({
        id: `line-${sortedLine[0]}-${sortedLine[sortedLine.length - 1]}`,
        start: sortedLine[0],
        end: sortedLine[sortedLine.length - 1],
        color: playerColors[scoringPlayer],
      })
    })

    // Update the master state object
    gameState = {
      ...gameState,
      scores: newScores,
      completedLines: newCompletedLines,
      highlightedCells: newHighlightedCells,
      winLinesToDraw: newWinLinesToDraw,
    }
  }

  function processPlayerMove(index, skipClickSound = false) {
    // This function now contains the core game logic
    const { wasBlock, linesBlocked } = checkForBlock(index)
    if (wasBlock) {
      gameState.playerStatsThisGame[gameState.currentPlayer].blocks +=
        linesBlocked
    }

    const move = {
      index: index,
      player: gameState.currentPlayer,
      scoredLines: [],
      blockPoints: 0,
      conquestState:
        gameState.gameMode === "Conquest" && gameState.conquestRotatingStarters
          ? {
              starter: gameState.conquestRoundStarter,
              roundOrder: [...gameState.conquestRoundOrder],
              turnIndex: gameState.conquestTurnIndex,
            }
          : null,
      stealthState:
        gameState.gameMode === "Stealth" && gameState.stealthRotatingStarters
          ? {
              starter: gameState.stealthRoundStarter,
              roundOrder: [...gameState.stealthRoundOrder],
              turnIndex: gameState.stealthTurnIndex,
            }
          : null,
      survivorState:
        gameState.gameMode === "Survivor" &&
        (gameState.survivorRotatingStarters || gameState.survivorEqualRounds)
          ? {
              starter: gameState.survivorRoundStarter,
              roundOrder: [...gameState.survivorRoundOrder],
              turnIndex: gameState.survivorTurnIndex,
              eliminatedThisRound: [...gameState.eliminatedThisRound],
            }
          : null,
    }

    const newBoard = [...gameState.board]
    newBoard[index] = gameState.currentPlayer

    const { pointsScored, shouldEndGame } = checkForWins(move, newBoard)

    let blockPoints = 0
    if (
      wasBlock &&
      pointsScored === 0 &&
      gameState.gameMode === "Conquest" &&
      gameState.conquestBlockPoints
    ) {
      blockPoints = Math.round(linesBlocked * 0.5 * 10) / 10
    }
    move.blockPoints = blockPoints

    if (blockPoints > 0) {
      const newScores = [...gameState.scores]
      newScores[gameState.currentPlayer] =
        Math.round((newScores[gameState.currentPlayer] + blockPoints) * 10) / 10
      gameState = { ...gameState, scores: newScores }
    }

    const scoreKey = pointsScored.toString()
    const playerGameStats =
      gameState.playerStatsThisGame[gameState.currentPlayer]
    if (pointsScored >= 2) {
      if (pointsScored <= 5) {
        playerGameStats.multiLineScores[scoreKey]++
      } else {
        playerGameStats.multiLineScores["6"]++
      }
    }

    let soundPromise = Promise.resolve()
    if (pointsScored > 0) {
      if (gameState.gameMode === "Survivor") {
        soundPromise = playSoundSequentially("eliminated", 1)
      } else {
        soundPromise = playSoundSequentially("score", pointsScored)
      }
    } else if (wasBlock && gameState.gameMode !== "Survivor") {
      soundPromise = playSoundSequentially("block", linesBlocked)
      const cell = gameBoard.querySelector(`[data-index='${index}']`)
      if (cell) {
        cell.classList.add("blocked")
        cell.addEventListener(
          "animationend",
          () => {
            cell.classList.remove("blocked")
          },
          { once: true },
        )
      }
    } else {
      if (!skipClickSound) {
        playSound("click")
      }
      soundPromise = new Promise((resolve) => setTimeout(resolve, 300))
    }

    const newMoveHistory = [...gameState.moveHistory, move]
    const newMovesMade = gameState.movesMade + 1

    gameState = {
      ...gameState,
      board: newBoard,
      movesMade: newMovesMade,
      moveHistory: newMoveHistory,
    }

    // Determine if the game is over, but don't call endGame here.
    let isGameOver = false

    if (gameState.gameMode === "Survivor") {
      const boardFull = newMovesMade === gameState.gridSize * gameState.gridSize

      if (gameState.survivorEqualRounds) {
        if (boardFull) {
          isGameOver = true
        } else {
          const nextTurnIndex = gameState.survivorTurnIndex + 1
          if (nextTurnIndex < gameState.survivorRoundOrder.length) {
            // Current round continues with the next scheduled player
            const nextPlayer = gameState.survivorRoundOrder[nextTurnIndex]
            gameState = {
              ...gameState,
              survivorTurnIndex: nextTurnIndex,
              currentPlayer: nextPlayer,
            }
            isGameOver = false
          } else {
            // --- CURRENT ROUND IS COMPLETE! ---
            const survivingPlayers = []
            for (let i = 0; i < gameState.numPlayers; i++) {
              if (!gameState.eliminatedPlayers.includes(i)) {
                survivingPlayers.push(i)
              }
            }

            if (survivingPlayers.length <= 1) {
              // Either 1 survivor (winner) or 0 survivors (tie among those eliminated this round)
              isGameOver = true
            } else {
              let nextStarter
              let nextRoundOrder

              if (gameState.survivorRotatingStarters) {
                // Advance to next round and ROTATE starter!
                nextStarter =
                  (gameState.survivorRoundStarter + 1) % gameState.numPlayers
                while (gameState.eliminatedPlayers.includes(nextStarter)) {
                  nextStarter = (nextStarter + 1) % gameState.numPlayers
                }

                nextRoundOrder = []
                for (let i = 0; i < gameState.numPlayers; i++) {
                  const p = (nextStarter + i) % gameState.numPlayers
                  if (survivingPlayers.includes(p)) {
                    nextRoundOrder.push(p)
                  }
                }
              } else {
                // Fixed sequential order of surviving players
                nextRoundOrder = [...survivingPlayers]
                nextStarter = nextRoundOrder[0]
              }

              gameState = {
                ...gameState,
                survivorRoundStarter: nextStarter,
                survivorRoundOrder: nextRoundOrder,
                survivorTurnIndex: 0,
                eliminatedThisRound: [],
                currentPlayer: nextRoundOrder[0],
              }
              isGameOver = false
            }
          }
        }
      } else {
        // Sudden death (survivorEqualRounds is false)
        isGameOver = shouldEndGame || boardFull

        if (!isGameOver) {
          if (gameState.survivorRotatingStarters) {
            let nextTurnIndex = gameState.survivorTurnIndex + 1
            while (
              nextTurnIndex < gameState.survivorRoundOrder.length &&
              gameState.eliminatedPlayers.includes(
                gameState.survivorRoundOrder[nextTurnIndex],
              )
            ) {
              nextTurnIndex++
            }

            if (nextTurnIndex < gameState.survivorRoundOrder.length) {
              const nextPlayer = gameState.survivorRoundOrder[nextTurnIndex]
              gameState = {
                ...gameState,
                survivorTurnIndex: nextTurnIndex,
                currentPlayer: nextPlayer,
              }
            } else {
              // Round complete! Rotate starter among surviving players
              const survivingPlayers = []
              for (let i = 0; i < gameState.numPlayers; i++) {
                if (!gameState.eliminatedPlayers.includes(i)) {
                  survivingPlayers.push(i)
                }
              }

              if (survivingPlayers.length <= 1) {
                isGameOver = true
              } else {
                let nextStarter =
                  (gameState.survivorRoundStarter + 1) % gameState.numPlayers
                while (gameState.eliminatedPlayers.includes(nextStarter)) {
                  nextStarter = (nextStarter + 1) % gameState.numPlayers
                }

                const nextRoundOrder = []
                for (let i = 0; i < gameState.numPlayers; i++) {
                  const p = (nextStarter + i) % gameState.numPlayers
                  if (survivingPlayers.includes(p)) {
                    nextRoundOrder.push(p)
                  }
                }

                gameState = {
                  ...gameState,
                  survivorRoundStarter: nextStarter,
                  survivorRoundOrder: nextRoundOrder,
                  survivorTurnIndex: 0,
                  eliminatedThisRound: [],
                  currentPlayer: nextRoundOrder[0],
                }
              }
            }
          } else {
            // Standard sequential order skipping eliminated players
            const nextPlayer = getNextPlayerIndex(gameState.currentPlayer)
            gameState = { ...gameState, currentPlayer: nextPlayer }
          }
        }
      }
    } else if (gameState.gameMode === "Conquest") {
      let isConquestGameOver = false
      let equalRoundsEnded = false
      if (gameState.conquestEqualRounds) {
        const fullRounds = Math.floor(
          (gameState.gridSize * gameState.gridSize) / gameState.numPlayers,
        )
        const maxMoves = fullRounds * gameState.numPlayers
        if (newMovesMade >= maxMoves) {
          isConquestGameOver = true
          equalRoundsEnded = true
        }
      } else {
        if (newMovesMade >= gameState.gridSize * gameState.gridSize) {
          isConquestGameOver = true
        }
      }

      isGameOver = isConquestGameOver

      const hasRemainingMoves =
        newMovesMade < gameState.gridSize * gameState.gridSize

      if (isGameOver && equalRoundsEnded && hasRemainingMoves) {
        if (blockPoints > 0) {
          const playerName = gameState.playerNames[gameState.currentPlayer]
          const ptsText = blockPoints === 1 ? "1 pt" : `${blockPoints} pts`
          const lineText = linesBlocked === 1 ? "1 line" : `${linesBlocked} lines`
          showSnackbar(
            `${playerName} blocked ${lineText}! (+${ptsText}) • No more equal rounds are left.`,
          )
        } else {
          showSnackbar("No more equal rounds are left.")
        }
      } else if (blockPoints > 0) {
        const playerName = gameState.playerNames[gameState.currentPlayer]
        const ptsText = blockPoints === 1 ? "1 pt" : `${blockPoints} pts`
        const lineText = linesBlocked === 1 ? "1 line" : `${linesBlocked} lines`
        showSnackbar(`${playerName} blocked ${lineText}! (+${ptsText})`)
      }

      if (!isGameOver) {
        if (gameState.conquestRotatingStarters) {
          const nextTurnIndex = gameState.conquestTurnIndex + 1
          if (nextTurnIndex < gameState.numPlayers) {
            const nextPlayer = gameState.conquestRoundOrder[nextTurnIndex]
            gameState = {
              ...gameState,
              conquestTurnIndex: nextTurnIndex,
              currentPlayer: nextPlayer,
            }
          } else {
            // Round finished! Advance starter and rotate for next round
            const nextStarter =
              (gameState.conquestRoundStarter + 1) % gameState.numPlayers
            const nextRoundOrder = Array.from(
              { length: gameState.numPlayers },
              (_, i) => (nextStarter + i) % gameState.numPlayers,
            )
            gameState = {
              ...gameState,
              conquestRoundStarter: nextStarter,
              conquestRoundOrder: nextRoundOrder,
              conquestTurnIndex: 0,
              currentPlayer: nextRoundOrder[0],
            }
          }
        } else {
          // Standard sequential order
          const nextPlayer =
            (gameState.currentPlayer + 1) % gameState.numPlayers
          gameState = { ...gameState, currentPlayer: nextPlayer }
        }
      }
    } else if (gameState.gameMode === "Stealth") {
      let isStealthGameOver = false
      let equalRoundsEnded = false
      if (gameState.stealthEqualRounds) {
        const fullRounds = Math.floor(
          (gameState.gridSize * gameState.gridSize) / gameState.numPlayers,
        )
        const maxMoves = fullRounds * gameState.numPlayers
        if (newMovesMade >= maxMoves) {
          isStealthGameOver = true
          equalRoundsEnded = true
        }
      } else {
        if (newMovesMade >= gameState.gridSize * gameState.gridSize) {
          isStealthGameOver = true
        }
      }

      isGameOver = isStealthGameOver

      const hasRemainingMoves =
        newMovesMade < gameState.gridSize * gameState.gridSize

      if (isGameOver && equalRoundsEnded && hasRemainingMoves) {
        showSnackbar("No more equal rounds are left.")
      }

      if (!isGameOver) {
        if (gameState.stealthRotatingStarters) {
          const nextTurnIndex = gameState.stealthTurnIndex + 1
          if (nextTurnIndex < gameState.numPlayers) {
            const nextPlayer = gameState.stealthRoundOrder[nextTurnIndex]
            gameState = {
              ...gameState,
              stealthTurnIndex: nextTurnIndex,
              currentPlayer: nextPlayer,
            }
          } else {
            // Round finished! Advance starter and rotate for next round
            const nextStarter =
              (gameState.stealthRoundStarter + 1) % gameState.numPlayers
            const nextRoundOrder = Array.from(
              { length: gameState.numPlayers },
              (_, i) => (nextStarter + i) % gameState.numPlayers,
            )
            gameState = {
              ...gameState,
              stealthRoundStarter: nextStarter,
              stealthRoundOrder: nextRoundOrder,
              stealthTurnIndex: 0,
              currentPlayer: nextRoundOrder[0],
            }
          }
        } else {
          // Standard sequential order
          const nextPlayer =
            (gameState.currentPlayer + 1) % gameState.numPlayers
          gameState = { ...gameState, currentPlayer: nextPlayer }
        }
      }
    } else {
      isGameOver =
        shouldEndGame || newMovesMade === gameState.gridSize * gameState.gridSize

      if (!isGameOver) {
        // Find the next active player if the game continues
        const nextPlayer = getNextPlayerIndex(gameState.currentPlayer)
        gameState = { ...gameState, currentPlayer: nextPlayer }
      }
    }

    return { isGameOver, soundPromise, wasBlock, pointsScored, blockPoints }
  }

  function checkForWins(move, currentBoard) {
    const { currentPlayer, gridSize, matchLength, completedLines, gameMode } =
      gameState
    let newPoints = 0
    let shouldEndGame = false

    const potentialWins = getWinningLines(
      currentBoard,
      currentPlayer,
      gridSize,
      matchLength,
    )
    const newWinningLines = potentialWins.filter(
      (line) => !completedLines.has(lineToString(line)),
    )

    if (newWinningLines.length > 0) {
      newPoints = newWinningLines.length
      applyWinningLines(newWinningLines, currentPlayer)

      // Add the scoring player to the eliminated list in Survivor mode
      if (
        gameMode === "Survivor" &&
        !gameState.eliminatedPlayers.includes(currentPlayer)
      ) {
        gameState.eliminatedPlayers.push(currentPlayer)
        if (gameState.survivorEqualRounds) {
          if (!gameState.eliminatedThisRound.includes(currentPlayer)) {
            gameState.eliminatedThisRound.push(currentPlayer)
          }
          const playerName = gameState.playerNames[currentPlayer]
          showSnackbar(`${playerName} is out! Completing the round...`)
        } else {
          const activePlayerCount =
            gameState.numPlayers - gameState.eliminatedPlayers.length
          if (activePlayerCount <= 1) {
            shouldEndGame = true
          }
        }
      }

      // End the game immediately in Classic mode
      if (gameMode === "Classic") {
        shouldEndGame = true
      }

      // Update the move history with the scored lines after applying them
      if (move) {
        move.scoredLines.push(...newWinningLines.map(lineToString))
      }
    }
    return { pointsScored: newPoints, shouldEndGame: shouldEndGame }
  }

  function checkForBlock(moveIndex) {
    let totalLinesBlocked = 0
    const originalPlayer = gameState.currentPlayer
    for (
      let opponentIndex = 0;
      opponentIndex < gameState.numPlayers;
      opponentIndex++
    ) {
      if (opponentIndex === originalPlayer) continue
      const tempBoard = [...gameState.board]
      tempBoard[moveIndex] = opponentIndex
      const potentialWins = getWinningLines(
        tempBoard,
        opponentIndex,
        gameState.gridSize,
        gameState.matchLength,
      )
      const newWins = potentialWins.filter(
        (line) =>
          line.includes(moveIndex) &&
          !gameState.completedLines.has(lineToString(line)),
      )
      totalLinesBlocked += newWins.length
    }
    return {
      wasBlock: totalLinesBlocked > 0,
      linesBlocked: totalLinesBlocked,
    }
  }

  // --- STATS MANAGEMENT FUNCTIONS ---

  function getStats() {
    try {
      const statsJSON = localStorage.getItem(STATS_KEY)
      // If stats exist, parse them; otherwise, return an empty object.
      return statsJSON ? JSON.parse(statsJSON) : {}
    } catch (error) {
      console.error("Error reading stats from localStorage:", error)
      // If there's a parsing error, return an empty object to prevent a crash.
      return {}
    }
  }

  function saveStats(statsObject) {
    try {
      const statsJSON = JSON.stringify(statsObject)
      localStorage.setItem(STATS_KEY, statsJSON)
    } catch (error) {
      console.error("Error saving stats to localStorage:", error)
    }
  }

  function identifyAndPreparePlayers(playerSetupArray) {
    const stats = getStats()
    const existingPlayers = {}
    // Create a quick lookup map of existing names to their IDs
    for (const id in stats) {
      existingPlayers[stats[id].name] = id
    }

    const identifiedPlayers = playerSetupArray.map((player, index) => {
      const existingId = existingPlayers[player.name]
      const voiceId = englishVoices[index % englishVoices.length].voice_id
      if (existingId) {
        // This is a returning player, use their existing ID
        return { ...player, id: existingId, voiceId, turnAudio: null }
      } else {
        // This is a new player, generate a new unique ID
        const newId = Date.now().toString() + Math.random().toString().slice(2)
        return { ...player, id: newId, voiceId, turnAudio: null }
      }
    })

    return identifiedPlayers
  }

  function updatePlayerStats(finalGameState, winnerIds) {
    const stats = getStats()
    const { players, scores, gameMode, gridSize, matchLength, moveHistory } =
      finalGameState

    const loserIds = players
      .map((p) => p.id)
      .filter((id) => !winnerIds.includes(id))

    players.forEach((player, index) => {
      const playerId = player.id
      const isWinner = winnerIds.includes(playerId)

      // Initialize a new player if they don't exist in the stats object
      if (!stats[playerId]) {
        stats[playerId] = {
          name: player.name,
          gamesPlayed: 0,
          wins: 0,
          currentWinStreak: 0,
          longestWinStreak: 0,
          nemesis: {},
          modes: {
            conquest: {
              gamesPlayed: 0,
              wins: 0,
              totalBlocks: 0,
              multiLineScoreCounts: { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
              configs: {},
            },
            stealth: {
              gamesPlayed: 0,
              wins: 0,
              perfectStealthGames: 0,
              configs: {},
            },
            classic: {
              gamesPlayed: 0,
              wins: 0,
              totalBlocks: 0,
              quickestWin: null,
              totalTurnsToWin: 0,
              gamesWonForAvg: 0,
            },
            survivor: {
              gamesPlayed: 0,
              wins: 0,
              totalBlocks: 0,
              totalSurvivalRank: 0,
              gamesFinished: 0,
            },
          },
        }
      }

      // --- Update Overall Stats ---
      stats[playerId].name = player.name // Keep name updated
      stats[playerId].gamesPlayed++
      if (isWinner) {
        stats[playerId].wins++
        stats[playerId].currentWinStreak++
        if (
          stats[playerId].currentWinStreak > stats[playerId].longestWinStreak
        ) {
          stats[playerId].longestWinStreak = stats[playerId].currentWinStreak
        }
        // Update nemesis count for all losers
        loserIds.forEach((loserId) => {
          const winnerName = stats[playerId].name
          if (stats[loserId]) {
            // Ensure loser exists
            stats[loserId].nemesis[winnerName] =
              (stats[loserId].nemesis[winnerName] || 0) + 1
          }
        })
      } else {
        stats[playerId].currentWinStreak = 0
      }

      // --- Update Mode-Specific Stats ---
      const modeStats = stats[playerId].modes[gameMode.toLowerCase()]
      modeStats.gamesPlayed++
      if (isWinner) modeStats.wins++

      const playerGameStats = finalGameState.playerStatsThisGame[index]
      if (playerGameStats) {
        // Safety check
        if (modeStats.totalBlocks !== undefined) {
          modeStats.totalBlocks += playerGameStats.blocks
        }
        if (modeStats.multiLineScoreCounts) {
          for (const key in playerGameStats.multiLineScores) {
            if (playerGameStats.multiLineScores[key] > 0) {
              modeStats.multiLineScoreCounts[key] +=
                playerGameStats.multiLineScores[key]
            }
          }
        }
      }
      switch (gameMode) {
        case "Conquest":
        case "Stealth":
          const configKey = `${gridSize}x${gridSize}-${matchLength}`
          if (!modeStats.configs[configKey]) {
            modeStats.configs[configKey] = {
              gamesPlayed: 0,
              totalPoints: 0,
              highScore: 0,
              bestScore: null,
            }
          }
          const configStats = modeStats.configs[configKey]
          configStats.gamesPlayed++
          configStats.totalPoints += scores[index]
          if (scores[index] > configStats.highScore)
            configStats.highScore = scores[index]
          if (
            configStats.bestScore === null ||
            scores[index] < configStats.bestScore
          )
            configStats.bestScore = scores[index]
          if (gameMode === "Stealth" && scores[index] === 0 && isWinner)
            modeStats.perfectStealthGames++
          break
        case "Classic":
          if (isWinner) {
            const turnsToWin = moveHistory.filter(
              (m) => m.player === index,
            ).length
            if (
              modeStats.quickestWin === null ||
              turnsToWin < modeStats.quickestWin
            ) {
              modeStats.quickestWin = turnsToWin
            }
            modeStats.totalTurnsToWin += turnsToWin
            modeStats.gamesWonForAvg++
          }
          break
        case "Survivor":
          let rank
          if (winnerIds.includes(players[index].id)) {
            rank = 1
          } else {
            const eliminationIndex =
              finalGameState.eliminatedPlayers.indexOf(index)

            if (eliminationIndex === -1) {
              // The player was not eliminated, so they are the winner (1st place)
              rank = 1
            } else {
              // The player was eliminated. Their rank is calculated from the end of the list.
              // e.g., in a 4-player game, 1st eliminated is 4th place (4 - 0).
              rank = players.length - eliminationIndex
            }
          }
          modeStats.totalSurvivalRank += rank
          modeStats.gamesFinished++
          break
      }
    })

    saveStats(stats)
    populatePlayerDatalist() // Refresh datalist with any new players
  }

  // --- UTILITY FUNCTIONS ---

  let snackbarTimer // This will hold our auto-hide timer
  let currentSnackbarAction = null // This will hold our action listener for cleanup

  function showSnackbar(message, action = null) {
    clearTimeout(snackbarTimer) // Clear any previous auto-hide timer

    const actionBtn = document.getElementById("snackbar-action-btn")

    // Clean up any previous action listener to prevent memory leaks
    if (currentSnackbarAction) {
      actionBtn.removeEventListener("click", currentSnackbarAction)
    }

    if (action && action.text && typeof action.callback === "function") {
      actionBtn.textContent = action.text
      actionBtn.style.display = "inline-flex"

      // Define the new action
      currentSnackbarAction = () => {
        action.callback()
        feedbackSnackbar.hidePopover()
      }

      actionBtn.addEventListener("click", currentSnackbarAction)
    } else {
      actionBtn.style.display = "none"
    }

    snackbarMessage.textContent = message
    feedbackSnackbar.showPopover()

    // Automatically hide it after 4 seconds if there's no action button
    if (!action) {
      snackbarTimer = setTimeout(() => {
        feedbackSnackbar.hidePopover()
      }, 4000)
    }
  }

  function getOrdinal(n) {
    if (n > 3 && n < 21) return `${n}th`
    switch (n % 10) {
      case 1:
        return `${n}st`
      case 2:
        return `${n}nd`
      case 3:
        return `${n}rd`
      default:
        return `${n}th`
    }
  }

  function getPlayerSets() {
    const setsJSON = localStorage.getItem(SHARED_SETS_KEY) || localStorage.getItem(PLAYER_SETS_KEY)
    return setsJSON ? JSON.parse(setsJSON) : {}
  }

  function setPlayerSets(sets) {
    localStorage.setItem(SHARED_SETS_KEY, JSON.stringify(sets))
    syncToUpstash(SHARED_SETS_KEY, sets)
  }

  function saveActiveSessionPlayers(namesArray, className = currentLoadedSetName) {
    if (window.SharedClassSync?.saveActivePlayers) {
      window.SharedClassSync.saveActivePlayers(namesArray, className)
    } else {
      localStorage.setItem(SHARED_ACTIVE_PLAYERS_KEY, JSON.stringify(namesArray))
      syncToUpstash(SHARED_ACTIVE_PLAYERS_KEY, namesArray)
    }
  }

  function getSavedPlayerNames() {
    const stats = JSON.parse(localStorage.getItem("wordTacToe_stats") || "{}")
    return Object.values(stats)
      .map((player) => player.name)
      .sort()
  }

  function populatePlayerDatalist() {
    const playerNames = getSavedPlayerNames()
    const datalist = document.getElementById("player-list-data")

    // Clear any existing options before adding new ones
    datalist.innerHTML = ""

    playerNames.forEach((name) => {
      const option = document.createElement("option")
      option.value = name
      datalist.appendChild(option)
    })
  }

  function updateGameModeHint(mode) {
    if (modeRulesPanel) {
      modeRulesPanel.classList.toggle("is-collapsed", mode === "Classic")
    }
    if (gameModeSelector) {
      gameModeSelector.querySelectorAll("button").forEach((btn) => {
        const isMatch = btn.dataset.mode === mode
        btn.classList.toggle("selected", isMatch)
        btn.setAttribute("aria-checked", isMatch ? "true" : "false")
      })
    }
    if (survivorOptionsGroup) {
      survivorOptionsGroup.classList.toggle("hidden", mode !== "Survivor")
    }
    if (conquestOptionsGroup) {
      conquestOptionsGroup.classList.toggle("hidden", mode !== "Conquest")
    }
    if (stealthOptionsGroup) {
      stealthOptionsGroup.classList.toggle("hidden", mode !== "Stealth")
    }
    switch (mode) {
      case "Conquest":
        if (gameModeHint) gameModeHint.textContent = "Get the most points."
        if (gameModeTooltipKo) {
          gameModeTooltipKo.textContent = "가장 많은 점수를 획득하세요."
        }
        break
      case "Stealth":
        if (gameModeHint) gameModeHint.textContent = "Get the fewest points."
        if (gameModeTooltipKo) {
          gameModeTooltipKo.textContent = "가장 적은 점수를 획득하세요."
        }
        break
      case "Classic":
        if (gameModeHint) gameModeHint.textContent = "The first score wins."
        if (gameModeTooltipKo) {
          gameModeTooltipKo.textContent = "먼저 점수를 획득하는 플레이어가 승리합니다."
        }
        break
      case "Survivor":
        if (gameModeHint) gameModeHint.textContent = "Get a point and you're out."
        if (gameModeTooltipKo) {
          gameModeTooltipKo.textContent = "점수를 얻으면 탈락합니다."
        }
        break
      default:
        if (gameModeHint) gameModeHint.textContent = "Get the most points."
        if (gameModeTooltipKo) {
          gameModeTooltipKo.textContent = "가장 많은 점수를 획득하세요."
        }
    }
  }

  function updateMatchLengthDefault(previousMode = null) {
    const currentSelectedBtn = gameModeSelector?.querySelector(
      "button.selected",
    )
    const currentMode = currentSelectedBtn
      ? currentSelectedBtn.dataset.mode
      : gameState.gameMode
    const playerCount = gameState.setup.players.length
    const currentGridSize = parseInt(gridSizeInput.value, 10)

    const shouldDefaultToTwo =
      (currentMode === "Survivor" && playerCount > 2) ||
      (currentMode === "Stealth" && currentGridSize === 3)

    if (shouldDefaultToTwo) {
      const modeChanged = previousMode && previousMode !== currentMode
      if (matchLengthInput.value === "3" || modeChanged) {
        matchLengthInput.value = 2
        matchLengthValue.textContent = "2"
        syncSliders()
      }
    } else {
      if (matchLengthInput.value === "2") {
        matchLengthInput.value = 3
        matchLengthValue.textContent = "3"
        syncSliders()
      }
    }
  }

  function updateRotatingStartersDefault(previousPlayerCount = null) {
    const playerCount = gameState.setup.players.length
    if (previousPlayerCount !== null && previousPlayerCount === playerCount) {
      return
    }

    // Conquest and Stealth default to OFF all the time
    if (conquestRotatingStarterToggle && !userSetConquestRotatingStarters) {
      conquestRotatingStarterToggle.checked = false
    }
    if (stealthRotatingStarterToggle && !userSetStealthRotatingStarters) {
      stealthRotatingStarterToggle.checked = false
    }

    // Survivor mode defaults to ON for > 2 players and OFF for <= 2 players
    if (survivorRotatingStarterToggle && !userSetSurvivorRotatingStarters) {
      survivorRotatingStarterToggle.checked = playerCount > 2
    }
  }

  function updateEqualRoundsDefault(previousPlayerCount = null) {
    const playerCount = gameState.setup.players.length
    if (previousPlayerCount !== null && previousPlayerCount === playerCount) {
      return
    }

    const isTwoPlayers = playerCount <= 2

    if (conquestEqualRoundsToggle && !userSetConquestEqualRounds) {
      conquestEqualRoundsToggle.checked = !isTwoPlayers
    }
    if (stealthEqualRoundsToggle && !userSetStealthEqualRounds) {
      stealthEqualRoundsToggle.checked = !isTwoPlayers
    }
    if (survivorEqualRoundsToggle && !userSetSurvivorEqualRounds) {
      survivorEqualRoundsToggle.checked = !isTwoPlayers
    }
    if (fairPlayToggle && fairPlayToggle !== survivorEqualRoundsToggle && !userSetSurvivorEqualRounds) {
      fairPlayToggle.checked = !isTwoPlayers
    }
  }

  function validatePlayerNames() {
    const nameInputs = Array.from(
      playerNamesContainer.querySelectorAll(".player-name-input"),
    )
    const names = nameInputs
      .map((input) => input.value.trim())
      .filter((name) => name !== "")

    const nameCounts = names.reduce((acc, name) => {
      acc[name] = (acc[name] || 0) + 1
      return acc
    }, {})

    const duplicateNames = new Set(
      Object.keys(nameCounts).filter((name) => nameCounts[name] > 1),
    )
    let hasErrors = false

    nameInputs.forEach((input) => {
      const field = input.closest(".field")
      const currentName = input.value.trim()
      const isDuplicate = duplicateNames.has(currentName) && currentName !== ""
      const isEmpty = currentName === ""

      // Clear previous error states and messages first
      field.classList.remove("error")
      const existingError = field.querySelector(
        ".supporting-text.error-message",
      )
      if (existingError) {
        existingError.remove()
      }

      let errorMessage = ""
      if (isEmpty) {
        errorMessage = "Name cannot be empty."
        hasErrors = true
      } else if (isDuplicate) {
        errorMessage = "This name is already in use."
        hasErrors = true
      }

      if (errorMessage) {
        field.classList.add("error")
        const errorText = document.createElement("span")
        errorText.className = "supporting-text error-message"
        errorText.textContent = errorMessage
        field.appendChild(errorText)
      }
    })

    startGameBtn.disabled = hasErrors
  }

  async function fetchElevenLabsAudio(text, voiceId) {
    if (!userApiKey) return null

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`
    const payload = {
      text: text,
      model_id: "eleven_flash_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        speed: 0.85,
      },
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": userApiKey,
        },
        body: JSON.stringify(payload),
      })

      if (response.ok) {
        const blob = await response.blob()
        const blobUrl = URL.createObjectURL(blob)
        return new Audio(blobUrl)
      } else {
        console.error(`ElevenLabs generation failed for "${text}":`, response.statusText)
      }
    } catch (e) {
      console.error(`Error generating ElevenLabs audio for "${text}":`, e)
    }
    return null
  }

  function stopAllTurnVoices() {
    if (playingTurnAudio) {
      try {
        playingTurnAudio.pause()
        playingTurnAudio.currentTime = 0
      } catch (e) {}
      playingTurnAudio = null
    }
  }

  function resetCachedTurnVoices() {
    if (!gameState.players) return
    gameState.players.forEach((player) => {
      if (player.turnAudio) {
        try {
          URL.revokeObjectURL(player.turnAudio.src)
        } catch (e) {}
        player.turnAudio = null
      }
    })
  }

  async function precachePlayerTurnAudios() {
    if (!userApiKey || !gameState.players || gameState.players.length === 0) return

    for (const player of gameState.players) {
      if (player.turnAudio) continue

      const audio = await fetchElevenLabsAudio(`${player.name}'s turn`, player.voiceId)
      if (audio) {
        player.turnAudio = audio
      }
    }
  }

  async function announceCurrentPlayerTurn() {
    if (gameState.isMuted || !userApiKey || !gameState.players || gameState.players.length === 0) return

    const activePlayer = gameState.players[gameState.currentPlayer]
    if (!activePlayer) return

    const targetPlayerIndex = gameState.currentPlayer

    // If player clicked a cell before the announcement is made, skip it
    if (currentTurnCellClicked) return

    if (activePlayer.turnAudio) {
      activePlayer.turnAudio.currentTime = 0
      playingTurnAudio = activePlayer.turnAudio
      // Final check before playing
      if (gameState.isMuted || currentTurnCellClicked || gameState.currentPlayer !== targetPlayerIndex) return
      activePlayer.turnAudio.play().catch((e) => console.error("Error playing turn audio:", e))
      return
    }

    const audio = await fetchElevenLabsAudio(`${activePlayer.name}'s turn`, activePlayer.voiceId)
    if (audio) {
      activePlayer.turnAudio = audio
      // Final check before playing
      if (gameState.isMuted || currentTurnCellClicked || gameState.currentPlayer !== targetPlayerIndex) return
      playingTurnAudio = audio
      audio.play().catch((e) => console.error("Error playing turn audio:", e))
    }
  }

  function announceCurrentPlayerTurnWithDelay(delay) {
    if (pendingTurnAnnouncementTimeout) {
      clearTimeout(pendingTurnAnnouncementTimeout)
      pendingTurnAnnouncementTimeout = null
    }

    const targetPlayerIndex = gameState.currentPlayer

    pendingTurnAnnouncementTimeout = setTimeout(() => {
      if (currentTurnCellClicked || gameState.currentPlayer !== targetPlayerIndex) return
      announceCurrentPlayerTurn()
    }, delay)
  }

  async function playPlayerTurnAudio(playerIndex) {
    if (gameState.isMuted || playerIndex !== gameState.currentPlayer) return

    const player = gameState.players?.[playerIndex]
    const playerName = player?.name || gameState.playerNames?.[playerIndex]
    if (!playerName) return

    stopAllTurnVoices()
    if (pendingTurnAnnouncementTimeout) {
      clearTimeout(pendingTurnAnnouncementTimeout)
      pendingTurnAnnouncementTimeout = null
    }

    if (player && player.turnAudio) {
      player.turnAudio.currentTime = 0
      playingTurnAudio = player.turnAudio
      player.turnAudio.play().catch((e) => console.error("Error playing turn audio:", e))
      return
    }

    if (userApiKey && player && player.voiceId) {
      const audio = await fetchElevenLabsAudio(`${playerName}'s turn`, player.voiceId)
      if (audio) {
        player.turnAudio = audio
        stopAllTurnVoices()
        playingTurnAudio = audio
        audio.play().catch((e) => console.error("Error playing turn audio:", e))
        return
      }
    }

    speak(`${playerName}'s turn`)
  }

  async function speak(text) {
    if (gameState.isMuted) return Promise.resolve()
    if (text.trim().length <= 1) {
      playSound("click")
      return new Promise((resolve) => setTimeout(resolve, 300))
    }

    // --- Primary Method: Try ElevenLabs API ---
    if (userApiKey) {
      const availableVoices = englishVoices.filter(
        (voice) => voice.voice_id !== lastVoiceId,
      )
      const randomVoice =
        availableVoices[Math.floor(Math.random() * availableVoices.length)]
      lastVoiceId = randomVoice.voice_id

      const url = `https://api.elevenlabs.io/v1/text-to-speech/${randomVoice.voice_id}`
      const headers = {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": userApiKey,
      }
      const body = JSON.stringify({
        text: text,
        model_id: "eleven_flash_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speed: 0.85,
        },
      })

      const voiceIdentifier = randomVoice.name || randomVoice.voice_id

      try {
        const response = await fetch(url, { method: "POST", headers, body })

        if (response.ok) {
          const audioBlob = await response.blob()
          const audioUrl = URL.createObjectURL(audioBlob)
          const audio = new Audio(audioUrl)
          await new Promise((resolve) => {
            audio.onended = () => resolve()
            audio.onerror = () => resolve()
            audio.play().catch((e) => {
              console.error(`Could not play audio: ${e}`)
              resolve()
            })
          })
          console.log(`Spoke with ElevenLabs voice: ${randomVoice.name}`)
          return // Success, so we exit the function here
        }

        const errorData = await response.json()
        const errorStatus = errorData.detail?.status
        const errorMessage =
          errorData.detail?.message || "An unknown API error occurred."

        console.error(
          `ElevenLabs API Error for voice "${voiceIdentifier}", attempting fallback:`,
          errorMessage,
        )

        switch (errorStatus) {
          case "invalid_api_key":
            localStorage.removeItem("elevenlabs_api_key")
            userApiKey = ""
            apiKeyInput.value = ""
            showSnackbar("API key is invalid. Please enter a new one.")
            updateApiFieldVisibility()
            break

          case "quota_exceeded":
            // Only show the snackbar if the user hasn't dismissed it this session
            if (!hasSeenQuotaWarning) {
              showSnackbar("You've exceeded your ElevenLabs quota.", {
                text: "Don't show again",
                callback: () => {
                  hasSeenQuotaWarning = true
                },
              })
            }
            break

          case "needs_tier_upgrade":
          case "unauthorized":
            showSnackbar(
              `ElevenLabs Error: Voice "${voiceIdentifier}" is premium only.`,
            )
            break

          default:
            if (errorMessage.includes("Free users cannot use library voices")) {
              showSnackbar(
                `ElevenLabs Error: Voice "${voiceIdentifier}" is premium only.`,
              )
            } else {
              showSnackbar(`ElevenLabs Error: ${errorMessage}`)
            }
            break
        }
      } catch (error) {
        console.error(
          `Failed to fetch from ElevenLabs for voice "${voiceIdentifier}", attempting fallback:`,
          error,
        )
        showSnackbar("ElevenLabs API failed. Using browser speech synthesis.")
      }
    }

    // --- Fallback Method: Browser Speech Synthesis ---
    // This code now runs if userApiKey is missing OR if the API call fails.
    await speakWithBrowser(text)
  }

  function speakWithBrowser(text) {
    if (!("speechSynthesis" in window)) {
      console.warn("Browser speech synthesis not supported.")
      showSnackbar("Browser speech synthesis not supported.")
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = "en-US"
      utterance.rate = 0.7
      utterance.pitch = 1.0
      utterance.onend = () => resolve()
      utterance.onerror = () => resolve()
      window.speechSynthesis.speak(utterance)
    })
  }

  function getNextPlayerIndex(currentPlayerIndex) {
    const { numPlayers, eliminatedPlayers } = gameState
    let nextPlayer = (currentPlayerIndex + 1) % numPlayers

    // Keep looping until we find a player who is NOT eliminated
    while (eliminatedPlayers.includes(nextPlayer)) {
      nextPlayer = (nextPlayer + 1) % numPlayers
      // Safeguard against infinite loops if all players are eliminated
      if (nextPlayer === currentPlayerIndex) return -1
    }
    return nextPlayer
  }

  // Ascending musical pitch offsets in cents (100 cents = 1 semitone)
  // Pentatonic intervals: 0 (Root), 200 (+1 whole step), 400 (+2 whole steps / Maj 3rd), 700 (5th), etc.
  const SCORE_PITCH_STEPS = [0, 200, 400, 700, 900, 1200, 1400, 1600]

  async function playScoreSequentially(times) {
    if (gameState.isMuted || times <= 0) return Promise.resolve()

    const ctx = getAudioContext()
    const buffer = scoreAudioBuffer || (await loadScoreAudioBuffer())

    // Web Audio API playback (supports dynamic pitch shifting and overlapping chimes)
    if (ctx && buffer) {
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {})
      }

      const stepDelay = 0.40 // 400ms interval between chimes
      const now = ctx.currentTime

      return new Promise((resolve) => {
        let lastSourceEnded = false
        const totalDuration = (times - 1) * stepDelay + buffer.duration

        for (let i = 0; i < times; i++) {
          const source = ctx.createBufferSource()
          source.buffer = buffer

          const detuneCents =
            SCORE_PITCH_STEPS[i] !== undefined
              ? SCORE_PITCH_STEPS[i]
              : i * 200
          source.detune.value = detuneCents

          source.connect(ctx.destination)

          const startTime = now + i * stepDelay
          source.start(startTime)

          if (i === times - 1) {
            source.onended = () => {
              if (!lastSourceEnded) {
                lastSourceEnded = true
                resolve()
              }
            }
          }
        }

        // Safety timeout in case onended is missed or delayed
        setTimeout(() => {
          if (!lastSourceEnded) {
            lastSourceEnded = true
            resolve()
          }
        }, totalDuration * 1000 + 100)
      })
    }

    // Fallback: HTML5 Audio with preservesPitch=false & playbackRate
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => {
        const audio = sounds.score ? sounds.score.cloneNode() : null
        if (!audio) return resolve()

        const cents =
          SCORE_PITCH_STEPS[i] !== undefined ? SCORE_PITCH_STEPS[i] : i * 200
        audio.preservesPitch = false
        audio.playbackRate = Math.pow(2, cents / 1200)

        audio.onended = () => resolve()
        audio.onerror = () => resolve()
        audio.play().catch((e) => {
          console.error(`Could not play score sound: ${e}`)
          resolve()
        })
      })
    }
  }

  async function playBlockSequentially(times) {
    if (gameState.isMuted || times <= 0) return Promise.resolve()

    const ctx = getAudioContext()
    const buffer = blockAudioBuffer || (await loadBlockAudioBuffer())

    if (ctx && buffer) {
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {})
      }

      const stepDelay = 0.28 // 280ms interval between block sounds
      const now = ctx.currentTime

      return new Promise((resolve) => {
        let lastSourceEnded = false
        const totalDuration = (times - 1) * stepDelay + buffer.duration

        for (let i = 0; i < times; i++) {
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(ctx.destination)

          const startTime = now + i * stepDelay
          source.start(startTime)

          if (i === times - 1) {
            source.onended = () => {
              if (!lastSourceEnded) {
                lastSourceEnded = true
                resolve()
              }
            }
          }
        }

        setTimeout(() => {
          if (!lastSourceEnded) {
            lastSourceEnded = true
            resolve()
          }
        }, totalDuration * 1000 + 100)
      })
    }

    // Fallback: HTML5 Audio
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => {
        const audio = sounds.block ? sounds.block.cloneNode() : null
        if (!audio) return resolve()
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
        audio.play().catch((e) => {
          console.error(`Could not play block sound: ${e}`)
          resolve()
        })
      })
    }
  }

  async function playEliminatedSound() {
    if (gameState.isMuted) return Promise.resolve()
    const audio = sounds.eliminated
    if (!audio) return Promise.resolve()
    return new Promise((resolve) => {
      audio.currentTime = 0
      audio.onended = () => resolve()
      audio.onerror = () => resolve()
      audio.play().catch((e) => {
        console.error(`Could not play eliminated sound: ${e}`)
        resolve()
      })
    })
  }

  function playSound(soundName) {
    if (gameState.isMuted) return
    const audio = sounds[soundName]
    if (audio) {
      audio.currentTime = 0
      audio.play().catch((e) => console.error(`Could not play sound: ${e}`))
    }
  }

  async function playSoundSequentially(soundName, times) {
    if (gameState.isMuted) return
    if (soundName === "score") {
      return playScoreSequentially(times)
    }
    if (soundName === "block") {
      return playBlockSequentially(times)
    }
    if (soundName === "eliminated") {
      return playEliminatedSound()
    }
    const audio = sounds[soundName]
    if (!audio) return
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => {
        audio.currentTime = 0
        audio.onended = () => resolve()
        audio.play().catch((e) => {
          console.error(`Could not play sound: ${e}`)
          resolve()
        })
      })
    }
  }

  function lineToString(line) {
    return [...line].sort((a, b) => a - b).join(",")
  }

  function getWinningLines(board, player, gridSize, matchLength) {
    const newWins = []
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        if (c <= gridSize - matchLength) {
          const line = Array.from(
            { length: matchLength },
            (_, i) => r * gridSize + c + i,
          )
          if (line.every((index) => board[index] === player)) newWins.push(line)
        }
        if (r <= gridSize - matchLength) {
          const line = Array.from(
            { length: matchLength },
            (_, i) => (r + i) * gridSize + c,
          )
          if (line.every((index) => board[index] === player)) newWins.push(line)
        }
        if (r <= gridSize - matchLength && c <= gridSize - matchLength) {
          const line = Array.from(
            { length: matchLength },
            (_, i) => (r + i) * gridSize + (c + i),
          )
          if (line.every((index) => board[index] === player)) newWins.push(line)
        }
        if (r <= gridSize - matchLength && c >= matchLength - 1) {
          const line = Array.from(
            { length: matchLength },
            (_, i) => (r + i) * gridSize + (c - i),
          )
          if (line.every((index) => board[index] === player)) newWins.push(line)
        }
      }
    }
    return newWins
  }

  function drawLine(startCell, endCell, color) {
    const gameBoard = document.getElementById("game-board")
    const boardRect = gameBoard.getBoundingClientRect()
    const startRect = startCell.getBoundingClientRect()
    const endRect = endCell.getBoundingClientRect()

    const line = document.createElement("div")
    line.classList.add("strike-through-line")
    line.style.backgroundColor = color

    const startX = startRect.left + startRect.width / 2 - boardRect.left
    const startY = startRect.top + startRect.height / 2 - boardRect.top
    const endX = endRect.left + endRect.width / 2 - boardRect.left
    const endY = endRect.top + endRect.height / 2 - boardRect.top

    const length = Math.sqrt(
      Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2),
    )
    const angle = Math.atan2(endY - startY, endX - startX) * (180 / Math.PI)

    line.style.width = `${length}px`
    line.style.left = `${startX}px`
    line.style.top = `${startY}px`
    line.style.transform = `rotate(${angle}deg)`

    gameBoard.appendChild(line)

    setTimeout(() => {
      line.style.clipPath = "inset(0 0 0 0)"
    }, 10)

    return line
  }

  function generatePlayerColors() {
    const selectedTheme = themeHueSelect.value

    if (selectedTheme === "bw") {
      // In B&W mode, use specific, vibrant colors for players.
      return [
        // "var(--red)",
        // "var(--blue)",
        // "var(--green)",
        // "var(--orange)",
        // "var(--purple)",
        "oklch(.71 0.1691 139.84)",
        "oklch(.71 0.1691 67.84)",
        "oklch(.71 0.1691 211.84)",
        "oklch(.71 0.1691 283.84)",
        "oklch(.71 0.1691 355.84)",
      ]
    } else {
      const colors = []

      const rawValue = themeHueSelect.value // Get the raw value, e.g. "var(--oklch-indigo)"
      const themeHuePropName = rawValue.slice(4, -1) // Extract the CSS variable name, e.g. "--oklch-indigo"
      const themeHueStringValue = getComputedStyle(
        document.documentElement,
      ).getPropertyValue(themeHuePropName) // Look up the value of the clean property name.
      const selectedHue = parseFloat(themeHueStringValue) // Convert to a number

      // To prevent player colors from being too close to the theme color,
      // we exclude a 120-degree arc around the theme color (selectedHue ± 60).
      // The remaining 240 degrees (opposite the theme) is used to distribute
      // the player colors.
      const exclusionArc = 120
      const allowedArc = 360 - exclusionArc // 240 degrees
      const startAngle = 60 // Start 60 degrees away from the theme hue
      const hueStep = allowedArc / (MAX_PLAYERS - 1) // Space colors evenly in the 240-degree arc

      for (let i = 0; i < MAX_PLAYERS; i++) {
        const hue = (selectedHue + startAngle + i * hueStep) % 360
        const color = `oklch(from var(--color-6) l c ${hue.toFixed(2)})`
        colors.push(color)
      }

      return colors
    }
  }

  function assignRandomColors(players, forceReshuffle = false) {
    if (!Array.isArray(players) || players.length === 0) return players

    const hasColors = players.every(
      (p) => typeof p.colorIndex === "number" && p.colorIndex >= 0 && p.colorIndex < MAX_PLAYERS,
    )
    const distinctColors = new Set(players.map((p) => p.colorIndex)).size === players.length

    if (hasColors && distinctColors && !forceReshuffle) {
      return players
    }

    const availableIndices = Array.from({ length: MAX_PLAYERS }, (_, i) => i)
    for (let i = availableIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[availableIndices[i], availableIndices[j]] = [availableIndices[j], availableIndices[i]]
    }

    if (!forceReshuffle) {
      const used = new Set(
        players
          .map((p) => p.colorIndex)
          .filter((idx) => typeof idx === "number" && idx >= 0 && idx < MAX_PLAYERS),
      )
      const unused = availableIndices.filter((idx) => !used.has(idx))
      return players.map((player) => {
        if (typeof player.colorIndex === "number" && player.colorIndex >= 0 && player.colorIndex < MAX_PLAYERS) {
          return player
        }
        return { ...player, colorIndex: unused.pop() ?? 0 }
      })
    } else {
      return players.map((player, idx) => ({
        ...player,
        colorIndex: availableIndices[idx % availableIndices.length],
      }))
    }
  }

  function updatePronunciationToggleState() {
    const isMuted = muteSoundsToggle.checked
    pronounceWordsToggle.disabled = isMuted
  }

  function saveSettings() {
    const isTwoPlayers = gameState.setup.players.length <= 2
    const settingsToSave = {
      numPlayers: gameState.setup.players.length,
      playerNames: gameState.setup.players,
      gridSize: gridSizeInput.value,
      matchLength: matchLengthInput.value,
      muteSounds: muteSoundsToggle.checked,
      pronounceWords: pronounceWordsToggle.checked,
      userSetConquestRotatingStarters,
      userSetStealthRotatingStarters,
      userSetSurvivorRotatingStarters,
      userSetConquestEqualRounds,
      userSetStealthEqualRounds,
      userSetSurvivorEqualRounds,
      fairPlay: survivorEqualRoundsToggle
        ? survivorEqualRoundsToggle.checked
        : !isTwoPlayers,
      survivorRotatingStarters: survivorRotatingStarterToggle
        ? survivorRotatingStarterToggle.checked
        : false,
      survivorEqualRounds: survivorEqualRoundsToggle
        ? survivorEqualRoundsToggle.checked
        : !isTwoPlayers,
      conquestBlockPoints: conquestBlockPointsToggle
        ? conquestBlockPointsToggle.checked
        : true,
      conquestRotatingStarters: conquestRotatingStarterToggle
        ? conquestRotatingStarterToggle.checked
        : false,
      conquestEqualRounds: conquestEqualRoundsToggle
        ? conquestEqualRoundsToggle.checked
        : !isTwoPlayers,
      stealthRotatingStarters: stealthRotatingStarterToggle
        ? stealthRotatingStarterToggle.checked
        : false,
      stealthEqualRounds: stealthEqualRoundsToggle
        ? stealthEqualRoundsToggle.checked
        : !isTwoPlayers,
      gameMode: document.querySelector("#gameModeSelector button.selected")
        ?.dataset.mode,
      selectedSeries: activeSeriesId,
      selectedUnits: Array.from(selectedUnitKeys),
      activeLevelKey: currentActiveLevelKey,
      darkMode: darkModeToggle.checked,
      themeHue: themeHueSelect.value,
    }

    localStorage.setItem(
      "phonics_game_settings",
      JSON.stringify(settingsToSave),
    )

    // Save active session players to shared storage and sync
    const activeNames = gameState.setup.players.map((p) => p.name).filter(Boolean)
    saveActiveSessionPlayers(activeNames)

    // Auto-sync units to active class profile in SharedClassSync
    if (currentLoadedSetName && typeof window.SharedClassSync !== "undefined") {
      const canonicals = settingsToSave.selectedUnits
        .map((s) => window.SharedClassSync.toCanonicalUnit(s)?.id)
        .filter(Boolean)
      if (canonicals.length > 0) {
        window.SharedClassSync.saveClassUnits(currentLoadedSetName, canonicals)
      }
    }
  }

  function loadSettings() {
    const savedSettings = localStorage.getItem("phonics_game_settings")
    const sharedActiveJSON = localStorage.getItem(SHARED_ACTIVE_PLAYERS_KEY)

    let playersList = []
    if (sharedActiveJSON) {
      try {
        const names = JSON.parse(sharedActiveJSON)
        if (Array.isArray(names) && names.length > 0) {
          playersList = names.map((name, index) => ({
            id: Date.now() + index,
            name: name
          }))
        }
      } catch (e) {
        console.error("Error parsing shared active players:", e)
      }
    }

    if (savedSettings) {
      const settings = JSON.parse(savedSettings)

      // Apply saved settings to the inputs
      if (playersList.length === 0) {
        playersList = settings.playerNames || []
      }
      gameState.setup.players = assignRandomColors(playersList, false)
      gridSizeInput.value = settings.gridSize || 3
      if (
        (settings.gameMode === "Survivor" &&
          playersList.length > 2 &&
          (!settings.matchLength || settings.matchLength == 3)) ||
        (settings.gameMode === "Stealth" &&
          (settings.gridSize || 3) == 3 &&
          (!settings.matchLength || settings.matchLength == 3))
      ) {
        matchLengthInput.value = 2
      } else {
        matchLengthInput.value = settings.matchLength || 3
      }
      muteSoundsToggle.checked = settings.muteSounds === true
      pronounceWordsToggle.checked = settings.pronounceWords === true
      userSetConquestRotatingStarters =
        settings.userSetConquestRotatingStarters === true
      userSetStealthRotatingStarters =
        settings.userSetStealthRotatingStarters === true
      userSetSurvivorRotatingStarters =
        settings.userSetSurvivorRotatingStarters === true
      userSetConquestEqualRounds =
        settings.userSetConquestEqualRounds === true
      userSetStealthEqualRounds =
        settings.userSetStealthEqualRounds === true
      userSetSurvivorEqualRounds =
        settings.userSetSurvivorEqualRounds === true
      const isTwoPlayers = playersList.length <= 2

      if (survivorRotatingStarterToggle) {
        survivorRotatingStarterToggle.checked =
          userSetSurvivorRotatingStarters
            ? settings.survivorRotatingStarters === true
            : !isTwoPlayers
      }
      if (survivorEqualRoundsToggle) {
        const savedEqualRounds =
          settings.survivorEqualRounds !== undefined
            ? settings.survivorEqualRounds === true
            : settings.fairPlay === true
        survivorEqualRoundsToggle.checked =
          userSetSurvivorEqualRounds
            ? savedEqualRounds
            : !isTwoPlayers
      }
      if (fairPlayToggle && fairPlayToggle !== survivorEqualRoundsToggle) {
        fairPlayToggle.checked = survivorEqualRoundsToggle.checked
      }
      if (conquestBlockPointsToggle) {
        conquestBlockPointsToggle.checked =
          settings.conquestBlockPoints !== false
      }
      if (conquestRotatingStarterToggle) {
        conquestRotatingStarterToggle.checked =
          userSetConquestRotatingStarters
            ? settings.conquestRotatingStarters === true
            : false
      }
      if (conquestEqualRoundsToggle) {
        conquestEqualRoundsToggle.checked =
          userSetConquestEqualRounds
            ? settings.conquestEqualRounds === true
            : !isTwoPlayers
      }
      if (stealthRotatingStarterToggle) {
        stealthRotatingStarterToggle.checked =
          userSetStealthRotatingStarters
            ? settings.stealthRotatingStarters === true
            : false
      }
      if (stealthEqualRoundsToggle) {
        stealthEqualRoundsToggle.checked =
          userSetStealthEqualRounds
            ? settings.stealthEqualRounds === true
            : !isTwoPlayers
      }
      darkModeToggle.checked = settings.darkMode === true
      themeHueSelect.value = settings.themeHue || "var(--oklch-indigo)"

      // Set the correct game mode button and panel
      updateGameModeHint(settings.gameMode || "Conquest")
    } else {
      // --- IF NO SETTINGS ARE FOUND (NEW USER), CREATE DEFAULTS ---
      if (playersList.length === 0) {
        playersList = [
          { id: `${Date.now()}_1`, name: "Player 1" },
          { id: `${Date.now()}_2`, name: "Player 2" },
        ]
      }
      gameState.setup.players = assignRandomColors(playersList, false)
      updateGameModeHint("Conquest")
    }

    // --- RE-CREATE WORD UNIT SELECTION & BOOK SELECTOR ---
    // Priority Chain: Explicit URL Param -> localStorage / Settings -> Default ('smart-phonics')
    const urlParams = new URLSearchParams(window.location.search)
    const urlSeries = urlParams.get("series") || urlParams.get("book")
    const urlUnitsParam = urlParams.get("units")
    const hasUrlUnits = urlUnitsParam !== null && urlUnitsParam.trim() !== ""
    const hasUrlSeries = Boolean(urlSeries)

    selectedUnitKeys.clear()

    if (hasUrlSeries || hasUrlUnits) {
      if (hasUrlSeries) {
        activeSeriesId = window.SharedClassSync ? window.SharedClassSync.toSeriesSlug(urlSeries) : urlSeries
      } else {
        const parsedUnits = urlUnitsParam.split(",").map((s) => s.trim()).filter(Boolean)
        activeSeriesId = getPrimarySeriesFromUnits(parsedUnits)
      }
      populateBookSelector()
      if (bookSelect) bookSelect.value = activeSeriesId

      if (hasUrlUnits) {
        const parsedUnits = urlUnitsParam.split(",").map((s) => s.trim()).filter(Boolean)
        const matchingUnits = parsedUnits.filter((u) => {
          const c = window.SharedClassSync ? window.SharedClassSync.toCanonicalUnit(u) : null
          return (c?.series || "smart-phonics") === activeSeriesId
        })
        const unitsToRender = matchingUnits.length > 0 ? matchingUnits : parsedUnits
        unitsToRender.forEach((unitValue) => {
          const ttValue = window.SharedClassSync ? window.SharedClassSync.toTicTacToe(unitValue) : unitValue
          if (ttValue) selectedUnitKeys.add(ttValue)
        })
      }
      if (selectedUnitKeys.size === 0) {
        currentActiveLevelKey = "level1"
      } else {
        const firstUnit = Array.from(selectedUnitKeys)[0]
        const info = getUnitData(firstUnit)
        if (info?.levelKey) currentActiveLevelKey = info.levelKey
      }
    } else {
      let savedActiveLevelKey = null
      if (savedSettings) {
        try {
          const settings = JSON.parse(savedSettings)
          if (settings.selectedSeries) {
            activeSeriesId = settings.selectedSeries
          } else if (settings.selectedUnits && settings.selectedUnits.length > 0) {
            activeSeriesId = getPrimarySeriesFromUnits(settings.selectedUnits)
          } else {
            activeSeriesId = "smart-phonics"
          }
          if (settings.activeLevelKey) {
            savedActiveLevelKey = settings.activeLevelKey
          }
        } catch {
          activeSeriesId = "smart-phonics"
        }
      } else {
        activeSeriesId = "smart-phonics"
      }
      populateBookSelector()
      if (bookSelect) bookSelect.value = activeSeriesId

      let loadedAny = false
      if (savedSettings) {
        try {
          const settings = JSON.parse(savedSettings)
          const validSavedUnits = (settings.selectedUnits || []).filter(Boolean)
          if (validSavedUnits.length > 0) {
            validSavedUnits.forEach((unitValue) => {
              const ttValue = window.SharedClassSync ? window.SharedClassSync.toTicTacToe(unitValue) : unitValue
              if (ttValue) selectedUnitKeys.add(ttValue)
            })
            loadedAny = selectedUnitKeys.size > 0
          }
        } catch {}
      }
      if (!loadedAny) {
        currentActiveLevelKey = savedActiveLevelKey || "level1"
      } else if (savedActiveLevelKey) {
        currentActiveLevelKey = savedActiveLevelKey
      } else {
        const firstUnit = Array.from(selectedUnitKeys)[0]
        const info = getUnitData(firstUnit)
        if (info?.levelKey) currentActiveLevelKey = info.levelKey
      }
    }

    renderWordSelectionUI()

    // Refresh the entire UI to reflect the loaded settings
    updateTheme()
    renderNameInputs()
    syncSliders()
    updateApiFieldVisibility()
    updatePronunciationToggleState()
    populatePlayerDatalist()
    updateRotatingStartersDefault()
    updateEqualRoundsDefault()
    syncUrlParameters()
  }

  // --- UNIFIED THEME LOGIC ---

  const darkModeToggle = document.getElementById("darkModeToggle")
  const themeHueSelect = document.getElementById("themeHueSelect")
  const htmlElement = document.documentElement

  function updateTheme() {
    const isDarkMode = darkModeToggle.checked
    const selectedTheme = themeHueSelect.value

    // Handle Dark/Light mode class
    if (isDarkMode) {
      htmlElement.classList.remove("light")
      htmlElement.classList.add("dark")
    } else {
      htmlElement.classList.remove("dark")
      htmlElement.classList.add("light")
    }

    // Handle Color/B&W mode class
    if (selectedTheme === "bw") {
      htmlElement.classList.add("theme-bw")
      htmlElement.style.removeProperty("--palette-hue")
    } else {
      htmlElement.classList.remove("theme-bw")
      htmlElement.style.setProperty("--palette-hue", selectedTheme)
    }

    // Dynamically update player symbol badges in setup if present
    const badges = playerNamesContainer?.querySelectorAll(".player-symbol-badge")
    if (badges && badges.length > 0) {
      const colors = generatePlayerColors()
      badges.forEach((badge, idx) => {
        const player = gameState.setup?.players?.[idx]
        const colorIdx = player?.colorIndex !== undefined ? player.colorIndex : idx
        if (colors[colorIdx]) {
          badge.style.backgroundColor = colors[colorIdx]
        }
      })
    }
  }

  // Set the initial theme based on system preference and default dropdown value
  darkModeToggle.checked = window.matchMedia(
    "(prefers-color-scheme: dark)",
  ).matches
  updateTheme()

  // Add listeners that call the single update function
  darkModeToggle.addEventListener("change", () => {
    updateTheme()
    // saveSettings()
  })

  themeHueSelect.addEventListener("change", () => {
    updateTheme()
    // saveSettings()
  })

  // --- SETUP PHASE FUNCTIONS (Imperative, run before game starts) ---

  function initGame(isFromSetup) {
    isMoveProcessing = false
    if (gameBoard) gameBoard.classList.remove("processing-move")
    // Clear any lingering pulse animations from the previous game
    gameBoard.querySelectorAll(".cell.pulse").forEach((cell) => {
      cell.classList.remove("pulse")
    })
    playerInfoList.innerHTML = ""

    let settings = {}

    if (isFromSetup) {
      // This block runs ONLY when you click "Start Game" from the main setup screen.
      // Ensure gameState.setup.players names reflect current input values in DOM
      const currentInputs = playerNamesContainer.querySelectorAll(".player-name-input")
      if (currentInputs.length === gameState.setup.players.length) {
        currentInputs.forEach((input, index) => {
          if (input.value.trim()) {
            gameState.setup.players[index].name = input.value.trim()
          }
        })
      }

      // Identify players, assigning existing IDs or creating new ones
      const preparedPlayers = identifyAndPreparePlayers(gameState.setup.players)
      settings.players = preparedPlayers // Store the full player objects (id, name)
      settings.playerNames = preparedPlayers.map((p) => p.name)

      settings.numPlayers = settings.players.length
      settings.gridSize = parseInt(gridSizeInput.value)
      settings.matchLength = parseInt(matchLengthInput.value)
      settings.gameMode = document.querySelector(
        "#gameModeSelector button.selected",
      ).dataset.mode
      const isTwoPlayers = settings.numPlayers <= 2
      settings.fairPlay =
        (survivorEqualRoundsToggle ? survivorEqualRoundsToggle.checked : !isTwoPlayers) &&
        (survivorRotatingStarterToggle
          ? survivorRotatingStarterToggle.checked
          : !isTwoPlayers)
      settings.survivorRotatingStarters = survivorRotatingStarterToggle
        ? survivorRotatingStarterToggle.checked
        : !isTwoPlayers
      settings.survivorEqualRounds = survivorEqualRoundsToggle
        ? survivorEqualRoundsToggle.checked
        : !isTwoPlayers
      settings.conquestBlockPoints = conquestBlockPointsToggle
        ? conquestBlockPointsToggle.checked
        : true
      settings.conquestRotatingStarters = conquestRotatingStarterToggle
        ? conquestRotatingStarterToggle.checked
        : false
      settings.conquestEqualRounds = conquestEqualRoundsToggle
        ? conquestEqualRoundsToggle.checked
        : !isTwoPlayers
      settings.stealthRotatingStarters = stealthRotatingStarterToggle
        ? stealthRotatingStarterToggle.checked
        : false
      settings.stealthEqualRounds = stealthEqualRoundsToggle
        ? stealthEqualRoundsToggle.checked
        : !isTwoPlayers
      settings.selectedUnits = Array.from(selectedUnitKeys)

      if (settings.selectedUnits.length === 0) {
        showSnackbar("Please select at least one word unit to start the game.")
        return
      }

      const dynamicColorPalette = generatePlayerColors()
      settings.playerColors = preparedPlayers.map((player, idx) => {
        const colorIdx = player.colorIndex !== undefined ? player.colorIndex : idx
        return dynamicColorPalette[colorIdx] || dynamicColorPalette[idx]
      })

      const shuffledRadii = [...playerRadii].sort(() => 0.5 - Math.random())
      settings.playerRadii = shuffledRadii.slice(0, settings.numPlayers)

      settings.pronounceWords = pronounceWordsToggle.checked

      // The initial gameState is built entirely from the setup screen settings.
      gameState = { ...gameState, ...settings }

      wordCache = getCombinedWords(
        gameState.selectedUnits,
        gameState.gridSize * gameState.gridSize,
      )
    }

    // This part runs for BOTH a new game from setup AND a reset/reordered game.
    // It takes the existing settings (which might have been reordered)
    // and resets the game-specific state properties for a fresh round.

    gameState = {
      ...gameState, // Carries over settings like player order, colors, etc.
      board: Array(gameState.gridSize * gameState.gridSize).fill(null),
      scores: Array(gameState.numPlayers).fill(0),
      currentPlayer: 0,
      movesMade: 0,
      completedLines: new Set(),
      moveHistory: [],
      highlightedCells: new Set(),
      winLinesToDraw: [],
      eliminatedPlayers: [],
      survivorRoundStarter: 0,
      survivorRoundOrder: Array.from(
        { length: gameState.numPlayers },
        (_, i) => i,
      ),
      survivorTurnIndex: 0,
      eliminatedThisRound: [],
      conquestRoundStarter: 0,
      conquestRoundOrder: Array.from(
        { length: gameState.numPlayers },
        (_, i) => i,
      ),
      conquestTurnIndex: 0,
      stealthRoundStarter: 0,
      stealthRoundOrder: Array.from(
        { length: gameState.numPlayers },
        (_, i) => i,
      ),
      stealthTurnIndex: 0,
      playerStatsThisGame: Array(gameState.numPlayers)
        .fill(null)
        .map(() => ({
          blocks: 0,
          multiLineScores: { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
        })),
      currentView: "game", // The game is now officially active
    }

    isOrderLocked = true // Lock the order and enable cell clicks

    addGameEventListeners()
    render() // Render the final game state

    // Precache player turn audios and trigger the first player's turn announcement
    currentTurnCellClicked = false
    stopAllTurnVoices()
    if (pendingTurnAnnouncementTimeout) {
      clearTimeout(pendingTurnAnnouncementTimeout)
      pendingTurnAnnouncementTimeout = null
    }
    precachePlayerTurnAudios()
    announceCurrentPlayerTurnWithDelay(500)
  }

  function handleAddPlayer() {
    if (gameState.setup.players.length >= MAX_PLAYERS) return

    const previousPlayerCount = gameState.setup.players.length
    const currentNames = new Set(gameState.setup.players.map((p) => p.name))
    let newPlayerName = `Player ${gameState.setup.players.length + 1}` // Default fallback name

    for (let i = 1; i <= MAX_PLAYERS; i++) {
      const potentialName = `Player ${i}`
      if (!currentNames.has(potentialName)) {
        newPlayerName = potentialName
        break // Found the first available name, so we can stop looking
      }
    }

    const usedColorIndices = new Set(
      gameState.setup.players
        .map((p) => p.colorIndex)
        .filter((idx) => typeof idx === "number"),
    )
    const availableColorIndices = Array.from({ length: MAX_PLAYERS }, (_, i) => i).filter(
      (idx) => !usedColorIndices.has(idx),
    )
    const chosenColorIndex =
      availableColorIndices.length > 0
        ? availableColorIndices[Math.floor(Math.random() * availableColorIndices.length)]
        : gameState.setup.players.length % MAX_PLAYERS

    const newPlayer = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: newPlayerName,
      colorIndex: chosenColorIndex,
    }

    gameState.setup.players.push(newPlayer)

    renderNameInputs()
    updatePlayerButtonsState()
    updateMatchLengthDefault()
    updateRotatingStartersDefault(previousPlayerCount)
    updateEqualRoundsDefault(previousPlayerCount)
    saveSettings()
    validatePlayerNames()
  }

  function handleRemovePlayer(e) {
    if (!e.target.closest(".remove-player-btn")) return
    if (gameState.setup.players.length <= 2) return // Enforce min players

    const wrapper = e.target.closest(".player-field-wrapper")
    if (!wrapper) return // Safety check

    const previousPlayerCount = gameState.setup.players.length
    const playerIdToRemove = String(wrapper.dataset.playerId)

    gameState.setup.players = gameState.setup.players.filter(
      (p) => String(p.id) !== playerIdToRemove,
    )

    renderNameInputs()
    updatePlayerButtonsState()
    updateMatchLengthDefault()
    updateRotatingStartersDefault(previousPlayerCount)
    updateEqualRoundsDefault(previousPlayerCount)
    saveSettings()
    validatePlayerNames()
  }

  function updatePlayerButtonsState() {
    const playerCount = gameState.setup.players.length

    // Disable "Add" button if at max
    addPlayerBtn.disabled = playerCount >= 5

    // Show/hide "Remove" buttons
    const removeButtons =
      playerNamesContainer.querySelectorAll(".remove-player-btn")
    const showRemoveButtons = playerCount > 2
    removeButtons.forEach((btn) =>
      btn.classList.toggle("hidden", !showRemoveButtons),
    )
  }

  function handleRandomizeGameMode() {
    const modeButtons = gameModeSelector.querySelectorAll("button")
    const currentSelectedBtn = gameModeSelector.querySelector("button.selected")
    const currentMode = currentSelectedBtn
      ? currentSelectedBtn.dataset.mode
      : null

    // Create a list of all modes EXCEPT the current one
    const availableModes = Array.from(modeButtons)
      .map((btn) => btn.dataset.mode)
      .filter((mode) => mode !== currentMode)

    // If there are no other modes to choose from, do nothing.
    if (availableModes.length === 0) return

    // Select a new random mode from the filtered list
    const newMode =
      availableModes[Math.floor(Math.random() * availableModes.length)]

    // Update the UI to reflect the new choice
    modeButtons.forEach((button) => {
      button.classList.toggle("selected", button.dataset.mode === newMode)
    })

    updateGameModeHint(newMode)
    updateMatchLengthDefault(currentMode)
    saveSettings()
    playSound("click")
  }

  function getCombinedWords(selectedUnits, totalWordsNeeded) {
    const finalWords = []
    const uniqueUnits = [...new Set(selectedUnits)]
    const wordsPerUnit = Math.floor(totalWordsNeeded / uniqueUnits.length)
    let remainder = totalWordsNeeded % uniqueUnits.length
    uniqueUnits.forEach((unitValue) => {
      let seriesKey = "smart-phonics"
      let level = ""
      let unit = ""
      const parts = unitValue.split("|")
      if (parts.length === 3) {
        seriesKey = parts[0]
        level = parts[1]
        unit = parts[2]
      } else {
        level = parts[0]
        unit = parts[1]
      }
      const bank = (smartPhonicsWordBank.series && smartPhonicsWordBank.series[seriesKey] && smartPhonicsWordBank.series[seriesKey].levels)
        ? smartPhonicsWordBank.series[seriesKey].levels
        : smartPhonicsWordBank;
      const unitData = bank?.[level]?.[unit]
      if (!unitData || !unitData.words) return

      const wordPool = [...unitData.words]
      const targetSound = unitData.targetSound || ""
      let wordsToTake = wordsPerUnit
      if (remainder > 0) {
        wordsToTake++
        remainder--
      }
      if (wordPool.length === 0) return
      for (let i = 0; i < wordsToTake; i++) {
        const word = wordPool[i % wordPool.length]
        finalWords.push({ word, target: targetSound })
      }
    })
    for (let i = finalWords.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[finalWords[i], finalWords[j]] = [finalWords[j], finalWords[i]]
    }
    return finalWords
  }

  function randomizePlayerOrder() {
    if (gameState.setup.players.length < 2) return
    const originalOrderJSON = JSON.stringify(gameState.setup.players)
    let attempts = 0
    do {
      const playersToShuffle = [...gameState.setup.players] // Create a mutable copy
      for (let i = playersToShuffle.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[playersToShuffle[i], playersToShuffle[j]] = [
          playersToShuffle[j],
          playersToShuffle[i],
        ]
      }
      // Re-assign new random colors for players on shuffle
      const playersWithNewColors = assignRandomColors(playersToShuffle, true)
      // Now, update the actual state with the shuffled copy
      gameState = {
        ...gameState,
        setup: {
          ...gameState.setup,
          players: playersWithNewColors,
        },
      }
      attempts++
    } while (
      JSON.stringify(gameState.setup.players) === originalOrderJSON &&
      attempts < 10
    )
    renderNameInputs()
    saveSettings()
    validatePlayerNames()
  }

  let activePointerDrag = null

  function movePlayerTo(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return
    if (fromIndex >= gameState.setup.players.length || toIndex >= gameState.setup.players.length) return

    const newPlayers = [...gameState.setup.players]
    const [itemToMove] = newPlayers.splice(fromIndex, 1)
    newPlayers.splice(toIndex, 0, itemToMove)

    gameState = {
      ...gameState,
      setup: {
        ...gameState.setup,
        players: newPlayers,
      },
    }
    renderNameInputs()
    saveSettings()
    validatePlayerNames()
    playSound("click")
  }

  function renderNameInputs() {
    playerNamesContainer.innerHTML = ""
    gameState.setup.players = assignRandomColors(gameState.setup.players, false)
    const colors = generatePlayerColors()

    gameState.setup.players.forEach((player, index) => {
      const wrapper = document.createElement("div")
      wrapper.className = "player-field-wrapper"
      wrapper.draggable = false
      wrapper.dataset.playerId = player.id
      wrapper.dataset.index = index

      wrapper.addEventListener("dragstart", (e) => {
        wrapper.classList.add("dragging")
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move"
          e.dataTransfer.setData("text/plain", String(player.id))
        }
      })
      wrapper.addEventListener("dragend", () => {
        wrapper.classList.remove("dragging")
        wrapper.draggable = false
        playerNamesContainer.querySelectorAll(".player-field-wrapper").forEach((el) => {
          el.classList.remove("drop-target")
        })
      })

      // 1. Drag Handle
      const dragHandle = document.createElement("span")
      dragHandle.className = "player-drag-handle"
      dragHandle.setAttribute("role", "button")
      dragHandle.setAttribute("tabindex", "0")
      dragHandle.setAttribute("aria-label", `Drag to reorder ${player.name || "Player " + (index + 1)}`)
      dragHandle.title = "Drag to reorder"
      dragHandle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"></circle><circle cx="9" cy="12" r="1.5"></circle><circle cx="9" cy="19" r="1.5"></circle><circle cx="15" cy="5" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle><circle cx="15" cy="19" r="1.5"></circle></svg>`

      // Mouse drag initiation: only clicking and holding the handle activates dragging
      dragHandle.addEventListener("mousedown", (e) => {
        if (e.button === 0) {
          wrapper.draggable = true
        }
      })
      dragHandle.addEventListener("mouseup", () => {
        if (!wrapper.classList.contains("dragging")) {
          wrapper.draggable = false
        }
      })
      dragHandle.addEventListener("mouseleave", () => {
        if (!wrapper.classList.contains("dragging")) {
          wrapper.draggable = false
        }
      })

      // Touch events for mobile/smartboards (Pointer events for touch only)
      dragHandle.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return // Handled by HTML5 drag above
        try {
          dragHandle.setPointerCapture(e.pointerId)
        } catch {}
        activePointerDrag = {
          pointerId: e.pointerId,
          fromIndex: index,
          wrapper: wrapper,
        }
        wrapper.classList.add("dragging")
      })

      dragHandle.addEventListener("pointermove", (e) => {
        if (!activePointerDrag || activePointerDrag.pointerId !== e.pointerId) return
        const target = document.elementFromPoint(e.clientX, e.clientY)
        const targetWrapper = target?.closest(".player-field-wrapper")
        playerNamesContainer.querySelectorAll(".player-field-wrapper").forEach((el) => {
          el.classList.toggle("drop-target", el === targetWrapper && el !== wrapper)
        })
      })

      const endPointerDrag = (e) => {
        if (!activePointerDrag || activePointerDrag.pointerId !== e.pointerId) return
        try {
          dragHandle.releasePointerCapture(e.pointerId)
        } catch {}
        wrapper.classList.remove("dragging")
        const target = document.elementFromPoint(e.clientX, e.clientY)
        const targetWrapper = target?.closest(".player-field-wrapper")
        playerNamesContainer.querySelectorAll(".player-field-wrapper").forEach((el) => {
          el.classList.remove("drop-target")
        })
        if (targetWrapper && targetWrapper !== wrapper) {
          const toIndex = parseInt(targetWrapper.dataset.index, 10)
          if (!isNaN(toIndex)) {
            movePlayerTo(activePointerDrag.fromIndex, toIndex)
          }
        }
        activePointerDrag = null
      }

      dragHandle.addEventListener("pointerup", endPointerDrag)
      dragHandle.addEventListener("pointercancel", endPointerDrag)

      // 2. Color & Symbol Badge
      const badge = document.createElement("span")
      badge.className = "player-symbol-badge"
      const colorIdx = player.colorIndex !== undefined ? player.colorIndex : index
      badge.style.backgroundColor = colors[colorIdx] || "var(--primary)"
      badge.textContent = playerSymbols[index] || `${index + 1}`
      badge.title = `Player ${index + 1}: ${playerSymbols[index] || ""}`

      // 3. Name Field
      const field = document.createElement("label")
      field.className = "field player-name-field"

      const label = document.createElement("span")
      label.className = "label"
      label.textContent = `Player ${index + 1} Name`

      const input = document.createElement("input")
      input.type = "text"
      input.className = "player-name-input"
      input.setAttribute("list", "player-list-data")
      input.value = player.name
      input.addEventListener("input", (e) => {
        const playerId = String(wrapper.dataset.playerId)
        gameState.setup.players = gameState.setup.players.map((p) =>
          String(p.id) === playerId ? { ...p, name: e.target.value } : p,
        )
        saveSettings()
        validatePlayerNames()
      })

      field.appendChild(label)
      field.appendChild(input)

      // 4. Stacked Chevrons
      const reorderGroup = document.createElement("div")
      reorderGroup.className = "player-reorder-group"

      const upBtn = document.createElement("button")
      upBtn.type = "button"
      upBtn.className = "chevron-btn move-up-btn"
      upBtn.setAttribute("aria-label", `Move ${player.name || "Player " + (index + 1)} up`)
      upBtn.title = "Move Up"
      upBtn.disabled = index === 0
      upBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`
      upBtn.addEventListener("click", () => movePlayerTo(index, index - 1))

      const downBtn = document.createElement("button")
      downBtn.type = "button"
      downBtn.className = "chevron-btn move-down-btn"
      downBtn.setAttribute("aria-label", `Move ${player.name || "Player " + (index + 1)} down`)
      downBtn.title = "Move Down"
      downBtn.disabled = index === gameState.setup.players.length - 1
      downBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`
      downBtn.addEventListener("click", () => movePlayerTo(index, index + 1))

      reorderGroup.appendChild(upBtn)
      reorderGroup.appendChild(downBtn)

      // 5. Remove Button
      const removeBtn = document.createElement("button")
      removeBtn.type = "button"
      removeBtn.className = "icon-button remove-player-btn"
      removeBtn.setAttribute("aria-label", `Remove Player ${index + 1}`)
      removeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`

      wrapper.appendChild(dragHandle)
      wrapper.appendChild(badge)
      wrapper.appendChild(field)
      wrapper.appendChild(reorderGroup)
      wrapper.appendChild(removeBtn)

      playerNamesContainer.appendChild(wrapper)
    })
    updatePlayerButtonsState()
  }

  function getPrimarySeriesFromUnits(canonicalUnits, profileCurriculumId = null) {
    if (profileCurriculumId) {
      return window.SharedClassSync ? window.SharedClassSync.toSeriesSlug(profileCurriculumId) : profileCurriculumId
    }
    if (!Array.isArray(canonicalUnits) || canonicalUnits.length === 0) {
      return "smart-phonics"
    }
    const counts = {}
    for (const u of canonicalUnits) {
      const c = window.SharedClassSync ? window.SharedClassSync.toCanonicalUnit(u) : null
      const series = c?.series || "smart-phonics"
      counts[series] = (counts[series] || 0) + 1
    }
    let maxSeries = "smart-phonics"
    let maxCount = 0
    for (const [series, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count
        maxSeries = series
      }
    }
    return maxSeries
  }

  function populateBookSelector() {
    const bookSelectEl = document.getElementById("book-select")
    if (!bookSelectEl) return

    const allSeriesEntries = (smartPhonicsWordBank.series && Object.keys(smartPhonicsWordBank.series).length > 0)
      ? Object.entries(smartPhonicsWordBank.series)
      : [["smart-phonics", { name: "Smart Phonics", levels: smartPhonicsWordBank }]]

    // Manage books button is visible only when total curriculum books > 1
    const manageBooksBtnEl = document.getElementById("manage-books-btn")
    if (manageBooksBtnEl) {
      manageBooksBtnEl.style.display = allSeriesEntries.length > 1 ? "inline-flex" : "none"
    }

    let visibleEntries = allSeriesEntries.filter(([slug]) => window.SharedClassSync ? !window.SharedClassSync.isBookHidden(slug) : true)
    if (visibleEntries.length === 0 && allSeriesEntries.length > 0) {
      visibleEntries = [allSeriesEntries[0]]
    }

    bookSelectEl.innerHTML = ""
    visibleEntries.forEach(([slug, obj]) => {
      const opt = document.createElement("option")
      opt.value = slug
      opt.textContent = obj.name || (window.SharedClassSync ? window.SharedClassSync.toSeriesDisplayName(slug) : slug)
      bookSelectEl.appendChild(opt)
    })

    // If an active class or URL specified activeSeriesId, ensure it's selectable even if hidden
    if (activeSeriesId && !Array.from(bookSelectEl.options).some((o) => o.value === activeSeriesId)) {
      const matched = allSeriesEntries.find(([slug]) => slug === activeSeriesId)
      if (matched) {
        const opt = document.createElement("option")
        opt.value = activeSeriesId
        opt.textContent = matched[1].name || (window.SharedClassSync ? window.SharedClassSync.toSeriesDisplayName(activeSeriesId) : activeSeriesId)
        bookSelectEl.appendChild(opt)
      }
    }

    if (activeSeriesId && Array.from(bookSelectEl.options).some((o) => o.value === activeSeriesId)) {
      bookSelectEl.value = activeSeriesId
    } else if (bookSelectEl.options.length > 0) {
      activeSeriesId = bookSelectEl.options[0].value
      bookSelectEl.value = activeSeriesId
    }

    const bookSelectField = document.getElementById("book-select-field")
    if (bookSelectField) {
      bookSelectField.style.display = bookSelectEl.options.length > 1 ? "" : "none"
    } else {
      bookSelectEl.style.display = bookSelectEl.options.length > 1 ? "" : "none"
    }
  }

  function renderManageBooksList() {
    if (!manageBooksList) return
    manageBooksList.innerHTML = ""

    const allSeriesEntries = (smartPhonicsWordBank.series && Object.keys(smartPhonicsWordBank.series).length > 0)
      ? Object.entries(smartPhonicsWordBank.series)
      : [["smart-phonics", { name: "Smart Phonics", levels: smartPhonicsWordBank }]]

    const visibleCount = allSeriesEntries.filter(([slug]) => window.SharedClassSync ? !window.SharedClassSync.isBookHidden(slug) : true).length

    allSeriesEntries.forEach(([slug, obj]) => {
      const isVisible = window.SharedClassSync ? !window.SharedClassSync.isBookHidden(slug) : true
      const isLastRemaining = isVisible && visibleCount <= 1

      const item = document.createElement("div")
      item.className = `book-switch-item${isLastRemaining ? " disabled" : ""}`
      if (isLastRemaining) {
        item.title = "At least one book must remain visible."
      }

      const textSpan = document.createElement("span")
      textSpan.className = "book-title"
      textSpan.textContent = obj.name || (window.SharedClassSync ? window.SharedClassSync.toSeriesDisplayName(slug) : slug)

      const switchLabel = document.createElement("label")
      switchLabel.className = "switch"

      const chk = document.createElement("input")
      chk.type = "checkbox"
      chk.role = "switch"
      chk.checked = isVisible
      chk.disabled = isLastRemaining
      chk.className = "book-visibility-checkbox"

      chk.addEventListener("change", async () => {
        let currentHidden = window.SharedClassSync ? [...window.SharedClassSync.getHiddenBooks()] : []
        const slugNorm = window.SharedClassSync ? window.SharedClassSync.toSeriesSlug(slug) : slug
        if (chk.checked) {
          currentHidden = currentHidden.filter((s) => s !== slugNorm)
        } else {
          if (!currentHidden.includes(slugNorm)) {
            currentHidden.push(slugNorm)
          }
        }
        if (window.SharedClassSync) {
          await window.SharedClassSync.setHiddenBooks(currentHidden)
        }

        // If activeSeriesId is now hidden, switch to first visible
        const remainingVisible = allSeriesEntries.filter(([s]) => window.SharedClassSync ? !window.SharedClassSync.isBookHidden(s) : true)
        if (!chk.checked && activeSeriesId === slug && remainingVisible.length > 0) {
          handleSeriesChange(remainingVisible[0][0])
        } else {
          populateBookSelector()
          renderManageBooksList()
        }
      })

      switchLabel.appendChild(chk)
      item.appendChild(textSpan)
      item.appendChild(switchLabel)
      manageBooksList.appendChild(item)
    })
  }

  function syncUrlParameters() {
    const newUrl = new URL(window.location.href)
    if (activeSeriesId && activeSeriesId !== "smart-phonics") {
      newUrl.searchParams.set("series", activeSeriesId)
    } else {
      newUrl.searchParams.delete("series")
      newUrl.searchParams.delete("book")
    }
    const selected = Array.from(selectedUnitKeys).filter(Boolean)
    if (selected.length > 0) {
      newUrl.searchParams.set("units", selected.join(","))
    } else {
      newUrl.searchParams.delete("units")
    }
    window.history.replaceState({}, "", newUrl)
  }

  function getActiveSeriesLevels() {
    if (smartPhonicsWordBank.series && Object.keys(smartPhonicsWordBank.series).length > 0) {
      let seriesObj = smartPhonicsWordBank.series[activeSeriesId]
      if (!seriesObj) {
        seriesObj = Object.values(smartPhonicsWordBank.series)[0]
      }
      return seriesObj?.levels || seriesObj || {}
    }
    return smartPhonicsWordBank.levels || smartPhonicsWordBank || {}
  }

  function getUnitData(unitKey) {
    if (!unitKey) return null
    let seriesKey = activeSeriesId || "smart-phonics"
    let level = ""
    let unit = ""
    const parts = unitKey.split("|")
    if (parts.length === 3) {
      seriesKey = parts[0]
      level = parts[1]
      unit = parts[2]
    } else {
      level = parts[0]
      unit = parts[1]
    }

    let levels = {}
    if (smartPhonicsWordBank.series && smartPhonicsWordBank.series[seriesKey]) {
      levels = smartPhonicsWordBank.series[seriesKey].levels || smartPhonicsWordBank.series[seriesKey]
    } else {
      levels = getActiveSeriesLevels()
    }

    const unitObj = levels?.[level]?.[unit]
    const levelNum = level.replace(/^level/i, "")
    const unitNum = unit.replace(/^unit/i, "")
    const unitTitle = unitObj?.unitTitle || ""
    const targetSound = unitObj?.targetSound || ""
    const words = unitObj?.words || []

    return {
      seriesKey,
      levelKey: level,
      unitKey: unit,
      fullKey: unitKey,
      levelNum,
      unitNum,
      unitTitle,
      targetSound,
      wordsCount: words.length
    }
  }

  function selectDefaultOrRandomUnit(forceRandom = false) {
    // Keep selection empty by default per user specification
    renderWordSelectionUI()
  }

  function renderLevelTabs() {
    if (!unitLevelTabs) return
    unitLevelTabs.innerHTML = ""

    const levels = getActiveSeriesLevels()
    const levelKeys = Object.keys(levels).filter((k) => k.startsWith("level"))

    if (levelKeys.length === 0) return

    if (!levelKeys.includes(currentActiveLevelKey)) {
      currentActiveLevelKey = levelKeys[0]
    }

    levelKeys.forEach((lvlKey) => {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.role = "tab"
      btn.className = "level-tab-btn"
      const isSelected = lvlKey === currentActiveLevelKey
      btn.setAttribute("aria-selected", isSelected ? "true" : "false")
      btn.setAttribute("tabindex", isSelected ? "0" : "-1")

      const lvlNum = lvlKey.replace(/^level/i, "")
      const labelSpan = document.createElement("span")
      labelSpan.textContent = `Level ${lvlNum}`
      btn.appendChild(labelSpan)

      // Count selected units belonging to this level
      let levelSelectedCount = 0
      selectedUnitKeys.forEach((key) => {
        const info = getUnitData(key)
        if (info && info.levelKey === lvlKey) {
          levelSelectedCount++
        }
      })

      if (levelSelectedCount > 0) {
        btn.title = `Level ${lvlNum} (${levelSelectedCount} unit${levelSelectedCount > 1 ? "s" : ""} selected)`
        const dot = document.createElement("span")
        dot.className = "level-tab-dot"
        dot.setAttribute("aria-hidden", "true")
        btn.appendChild(dot)
      } else {
        btn.title = `Level ${lvlNum}`
      }

      btn.addEventListener("click", () => {
        currentActiveLevelKey = lvlKey
        saveSettings()
        renderLevelTabs()
        renderActiveLevelToolbar()
        renderUnitChipsGrid()
      })

      unitLevelTabs.appendChild(btn)
    })
  }

  function renderActiveLevelToolbar() {
    if (!activeLevelToolbar || !toggleLevelAllBtn) return

    const levels = getActiveSeriesLevels()
    const currentUnits = levels[currentActiveLevelKey] || {}
    const totalUnitsInLevel = Object.keys(currentUnits).length

    let selectedInLevel = 0
    for (const u in currentUnits) {
      const fullKey = activeSeriesId === "smart-phonics"
        ? `${currentActiveLevelKey}|${u}`
        : `${activeSeriesId}|${currentActiveLevelKey}|${u}`
      if (selectedUnitKeys.has(fullKey)) {
        selectedInLevel++
      }
    }

    if (activeLevelTitle) {
      const lvlNum = currentActiveLevelKey.replace(/^level/i, "")
      activeLevelTitle.textContent = selectedInLevel > 0
        ? `Level ${lvlNum} Units (${selectedInLevel} selected)`
        : `Level ${lvlNum} Units`
    }

    if (totalUnitsInLevel > 0 && selectedInLevel === totalUnitsInLevel) {
      toggleLevelAllBtn.textContent = "Deselect All"
    } else {
      toggleLevelAllBtn.textContent = "Select All"
    }
  }

  function renderUnitChipsGrid() {
    if (!unitChipsGrid) return
    unitChipsGrid.innerHTML = ""

    const levels = getActiveSeriesLevels()
    const currentUnits = levels[currentActiveLevelKey] || {}

    for (const u in currentUnits) {
      const unitData = currentUnits[u]
      const fullKey = activeSeriesId === "smart-phonics"
        ? `${currentActiveLevelKey}|${u}`
        : `${activeSeriesId}|${currentActiveLevelKey}|${u}`
      const isSelected = selectedUnitKeys.has(fullKey)

      const chip = document.createElement("button")
      chip.type = "button"
      chip.className = "unit-chip"
      chip.setAttribute("aria-pressed", isSelected ? "true" : "false")

      const uNum = u.replace(/^unit/i, "")
      const indexSpan = document.createElement("span")
      indexSpan.className = "unit-chip-index"
      indexSpan.textContent = `Unit ${uNum}`

      const titleSpan = document.createElement("span")
      titleSpan.className = "unit-chip-title"
      titleSpan.textContent = unitData.unitTitle || unitData.targetSound || ""
      if (unitData.words && unitData.words.length > 0) {
        chip.title = `${unitData.unitTitle || "Unit " + uNum} (${unitData.words.length} words)\n${unitData.words.slice(0, 8).join(", ")}${unitData.words.length > 8 ? "..." : ""}`
      }

      chip.appendChild(indexSpan)
      chip.appendChild(titleSpan)

      chip.addEventListener("click", () => {
        toggleUnit(fullKey)
      })

      unitChipsGrid.appendChild(chip)
    }
  }

  function toggleUnit(unitKey) {
    if (selectedUnitKeys.has(unitKey)) {
      selectedUnitKeys.delete(unitKey)
    } else {
      selectedUnitKeys.add(unitKey)
    }
    renderLevelTabs()
    renderActiveLevelToolbar()
    renderUnitChipsGrid()
    saveSettings()
    syncUrlParameters()
  }

  function toggleLevelAll() {
    const levels = getActiveSeriesLevels()
    const currentUnits = levels[currentActiveLevelKey] || {}
    const totalUnits = Object.keys(currentUnits).length
    if (totalUnits === 0) return

    let selectedCount = 0
    const keysInLevel = []
    for (const u in currentUnits) {
      const fullKey = activeSeriesId === "smart-phonics"
        ? `${currentActiveLevelKey}|${u}`
        : `${activeSeriesId}|${currentActiveLevelKey}|${u}`
      keysInLevel.push(fullKey)
      if (selectedUnitKeys.has(fullKey)) {
        selectedCount++
      }
    }

    if (selectedCount === totalUnits) {
      keysInLevel.forEach((k) => selectedUnitKeys.delete(k))
    } else {
      keysInLevel.forEach((k) => selectedUnitKeys.add(k))
    }

    renderLevelTabs()
    renderActiveLevelToolbar()
    renderUnitChipsGrid()
    saveSettings()
    syncUrlParameters()
  }

  function handleResetUnits() {
    selectedUnitKeys.clear()
    renderLevelTabs()
    renderActiveLevelToolbar()
    renderUnitChipsGrid()
    saveSettings()
    syncUrlParameters()
    playSound("click")
  }

  function handleSeriesChange(newSeriesId) {
    activeSeriesId = newSeriesId
    selectedUnitKeys.clear()
    currentActiveLevelKey = "level1"
    renderWordSelectionUI()
    syncUrlParameters()
    saveSettings()
  }

  function renderWordSelectionUI() {
    populateBookSelector()
    renderLevelTabs()
    renderActiveLevelToolbar()
    renderUnitChipsGrid()
  }

  function syncSliders() {
    const newGridSize = parseInt(gridSizeInput.value, 10)
    gridSizeValue.textContent = `${newGridSize}x${newGridSize}`
    const newMaxMatchLength = Math.min(newGridSize, 5)
    matchLengthInput.max = newMaxMatchLength
    if (parseInt(matchLengthInput.value) > newMaxMatchLength) {
      matchLengthInput.value = newMaxMatchLength
    }
    matchLengthValue.textContent = matchLengthInput.value
  }

  function highlightTargetSounds(word, targetSoundString) {
    if (!targetSoundString) {
      return `<span>${word}</span>`
    }
    const targetSounds = targetSoundString.split(",").map((s) => s.trim())
    let resultHTML = ""
    let i = 0
    while (i < word.length) {
      let foundMatch = false
      for (const sound of targetSounds) {
        if (sound.includes("_")) {
          const parts = sound.split("_")
          if (
            i + 2 < word.length &&
            word[i]?.toLowerCase() === parts[0] &&
            word[i + 2]?.toLowerCase() === parts[1]
          ) {
            resultHTML += `<span class="target-sounds">${word[i]}</span>`
            resultHTML += `<span>${word[i + 1]}</span>`
            resultHTML += `<span class="target-sounds">${word[i + 2]}</span>`
            i += 3
            foundMatch = true
            break
          }
        } else if (
          word.substring(i, i + sound.length).toLowerCase() === sound
        ) {
          resultHTML += `<span class="target-sounds">${word.substring(
            i,
            i + sound.length,
          )}</span>`
          i += sound.length
          foundMatch = true
          break
        }
      }
      if (!foundMatch) {
        resultHTML += `<span>${word[i]}</span>`
        i++
      }
    }
    return `<span class="word-wrapper">${resultHTML}</span>`
  }

  function determineWinners(finalGameState) {
    const { players, scores, gameMode, eliminatedPlayers } = finalGameState
    let winnerIds = []

    if (gameMode === "Stealth") {
      const minScore = Math.min(...scores)
      players.forEach((p, i) => {
        if (scores[i] === minScore) winnerIds.push(p.id)
      })
    } else if (gameMode === "Survivor") {
      const survivors = players.filter(
        (p, index) => !eliminatedPlayers.includes(index),
      )
      if (survivors.length > 0) {
        survivors.forEach((p) => winnerIds.push(p.id))
      } else if (
        finalGameState.survivorEqualRounds &&
        finalGameState.eliminatedThisRound &&
        finalGameState.eliminatedThisRound.length > 0
      ) {
        // If all remaining players were eliminated in the same round, they tie!
        finalGameState.eliminatedThisRound.forEach((playerIndex) => {
          if (players[playerIndex]) {
            winnerIds.push(players[playerIndex].id)
          }
        })
      }
    } else {
      // Conquest and Classic
      const maxScore = Math.max(...scores)
      if (maxScore > 0) {
        players.forEach((p, i) => {
          if (scores[i] === maxScore) winnerIds.push(p.id)
        })
      }
    }
    return winnerIds
  }

  function endGame() {
    const winnerIds = determineWinners(gameState)
    updatePlayerStats(gameState, winnerIds)

    const dialogTitle = document.getElementById("dialog-title")
    const dialogContent = document.getElementById("dialog-content")

    let winnerText
    if (winnerIds.length === 0) {
      winnerText = "It's a draw!"
    } else if (winnerIds.length > 1) {
      const winnerNames = winnerIds
        .map((id) => gameState.players.find((p) => p.id === id).name)
        .join(" & ")
      winnerText = `It's a tie between: ${winnerNames}!`
    } else {
      const winnerName = gameState.players.find(
        (p) => p.id === winnerIds[0],
      ).name
      winnerText = `${winnerName} wins!`
    }

    if (winnerIds.length > 0) {
      dialogTitle.innerHTML = `Congratulations! 🎉`
    } else {
      dialogTitle.innerHTML = `Game Over`
    }

    let winnerHTML = `<h3 class="h4 winner-text">${winnerText}</h3>`

    let finalScoresHTML = ""

    // Only build and display the score/rank list if the game mode is NOT Classic.
    if (gameState.gameMode !== "Classic") {
      const sortedPlayers = gameState.players.map((player, index) => {
        let rank = null
        if (gameState.gameMode === "Survivor") {
          if (winnerIds.includes(player.id)) {
            rank = 1
          } else {
            const eliminationIndex = gameState.eliminatedPlayers.indexOf(index)
            if (eliminationIndex === -1) {
              rank = 1 // Winner
            } else {
              rank = gameState.players.length - eliminationIndex
            }
          }
        }
        return {
          id: player.id,
          name: player.name,
          score: gameState.scores[index],
          symbol: playerSymbols[index],
          rank: rank,
        }
      })

      // Sort players based on game mode
      if (gameState.gameMode === "Survivor") {
        sortedPlayers.sort((a, b) => a.rank - b.rank)
      } else if (gameState.gameMode === "Stealth") {
        sortedPlayers.sort((a, b) => a.score - b.score)
      } else {
        sortedPlayers.sort((a, b) => b.score - a.score)
      }

      let scoreListHTML = `<div class="score-list">`
      const trophyIcon = "🏆"

      sortedPlayers.forEach((player) => {
        const isWinner = winnerIds.includes(player.id)
        const winnerClass = isWinner ? "winner" : ""

        const displayText =
          gameState.gameMode === "Survivor"
            ? getOrdinal(player.rank)
            : player.score

        scoreListHTML += `
        <div class="score-line ${winnerClass}">
          ${isWinner ? trophyIcon : ""}
          <span>${player.name}: ${displayText}</span>
        </div>
      `
      })

      scoreListHTML += `</div>`
      finalScoresHTML = scoreListHTML // Assign the generated HTML to the final variable
    }

    dialogContent.innerHTML = winnerHTML + finalScoresHTML

    setTimeout(() => {
      playSound("gameOver")
      gameDialog.showModal()
    }, 1500)
  }

  function resetSettings() {
    selectedUnitKeys.clear()
    userSetConquestRotatingStarters = false
    userSetStealthRotatingStarters = false
    userSetSurvivorRotatingStarters = false
    userSetConquestEqualRounds = false
    userSetStealthEqualRounds = false
    userSetSurvivorEqualRounds = false
    gameState.setup.players = assignRandomColors([
      { id: `${Date.now()}_1`, name: "Player 1" },
      { id: `${Date.now()}_2`, name: "Player 2" },
    ], true)

    gridSizeInput.value = 3
    matchLengthInput.value = 3
    muteSoundsToggle.checked = false
    pronounceWordsToggle.checked = true
    if (survivorRotatingStarterToggle) {
      survivorRotatingStarterToggle.checked = false
    }
    if (survivorEqualRoundsToggle) {
      survivorEqualRoundsToggle.checked = false
    }
    if (fairPlayToggle && fairPlayToggle !== survivorEqualRoundsToggle) {
      fairPlayToggle.checked = false
    }
    if (conquestBlockPointsToggle) {
      conquestBlockPointsToggle.checked = true
    }
    if (conquestRotatingStarterToggle) {
      conquestRotatingStarterToggle.checked = false
    }
    if (conquestEqualRoundsToggle) {
      conquestEqualRoundsToggle.checked = false
    }
    if (stealthRotatingStarterToggle) {
      stealthRotatingStarterToggle.checked = false
    }
    if (stealthEqualRoundsToggle) {
      stealthEqualRoundsToggle.checked = false
    }

    // Reset theme color dropdown and trigger the change
    // themeHueSelect.value = "var(--oklch-indigo)"
    // themeHueSelect.dispatchEvent(new Event("change"))

    // Reset game mode to Conquest
    updateGameModeHint("Conquest")

    // Reset word selection (keep empty)
    selectedUnitKeys.clear()
    currentActiveLevelKey = "level1"
    renderWordSelectionUI()
    syncUrlParameters()

    // Update the UI
    renderNameInputs()
    updatePlayerButtonsState()
    syncSliders()
    updateApiFieldVisibility()
    updatePronunciationToggleState()
    currentLoadedSetName = null
    saveSettings()
  }

  function randomizeTurnOrder() {
    if (gameState.playerNames.length < 2) return // No need to shuffle one player

    // Keep shuffling until the new order is different from the original
    // This is a great way to ensure a noticeable change for the user
    const originalOrderJSON = JSON.stringify(gameState.playerNames)
    let attempts = 0
    do {
      for (let i = gameState.playerNames.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        // Shuffle names, colors, and radii together to keep them linked
        ;[gameState.playerNames[i], gameState.playerNames[j]] = [
          gameState.playerNames[j],
          gameState.playerNames[i],
        ]
        ;[gameState.playerColors[i], gameState.playerColors[j]] = [
          gameState.playerColors[j],
          gameState.playerColors[i],
        ]
        ;[gameState.playerRadii[i], gameState.playerRadii[j]] = [
          gameState.playerRadii[j],
          gameState.playerRadii[i],
        ]
        ;[gameState.players[i], gameState.players[j]] = [
          gameState.players[j],
          gameState.players[i],
        ]
      }
      attempts++
    } while (
      JSON.stringify(gameState.playerNames) === originalOrderJSON &&
      attempts < 10
    )

    renderPlayerInfo()
    saveActiveSessionPlayers(gameState.playerNames)
  }

  function lockOrderAndStartGame() {
    initGame(true) // Call with 'true' to indicate it's from the setup screen
  }

  function updateApiFieldVisibility() {
    const apiSettingsSection = document.getElementById("api-settings-section")
    if (apiSettingsSection) {
      const isPronunciationOn = pronounceWordsToggle.checked
      // Only show the section if pronunciation is on AND we don't have a key
      const shouldShow = isPronunciationOn && !userApiKey
      apiSettingsSection.style.display = shouldShow ? "block" : "none"
    }
    updateSyncFieldVisibility()
  }

  function updateSyncFieldVisibility() {
    const syncSettingsSection = document.getElementById("sync-settings-section")
    if (syncSettingsSection) {
      const savedUrl = localStorage.getItem(UPSTASH_URL_KEY)
      const savedToken = localStorage.getItem(UPSTASH_TOKEN_KEY)
      const shouldShow = !savedUrl || !savedToken
      syncSettingsSection.style.display = shouldShow ? "block" : "none"
    }
  }

  function populateSetsDialog() {
    const sets = getPlayerSets()
    savedSetsList.innerHTML = "" // Clear the current list

    if (Object.keys(sets).length === 0) {
      savedSetsList.innerHTML = '<p class="field-hint">No saved lists yet.</p>'
      return
    }

    const sortedNames = Object.keys(sets).sort()
    for (const setName of sortedNames) {
      const setItem = document.createElement("div")
      setItem.className = "saved-set-item"

      const nameEl = document.createElement("span")
      nameEl.textContent = setName

      const actionsEl = document.createElement("div")
      actionsEl.className = "button-group"

      const loadBtn = document.createElement("button")
      loadBtn.textContent = "Load"
      loadBtn.className = "button tonal small"
      loadBtn.onclick = () => handleLoadSet(setName)

      const deleteBtn = document.createElement("button")
      deleteBtn.textContent = "Delete"
      deleteBtn.className = "button outlined small"
      deleteBtn.onclick = () => handleDeleteSet(setName)

      actionsEl.appendChild(loadBtn)
      actionsEl.appendChild(deleteBtn)
      setItem.appendChild(nameEl)
      setItem.appendChild(actionsEl)
      savedSetsList.appendChild(setItem)
    }
  }

  function applyUnitsToTicTacToe(canonicalUnits, profileCurriculumId = null) {
    if (!Array.isArray(canonicalUnits) || canonicalUnits.length === 0) return
    if (!unitChipsGrid) return

    // 1. Resolve primary series from profile and units (majority vote fallback)
    const primarySeries = getPrimarySeriesFromUnits(canonicalUnits, profileCurriculumId)
    activeSeriesId = primarySeries
    populateBookSelector()
    const bookSelectEl = document.getElementById("book-select")
    if (bookSelectEl) bookSelectEl.value = activeSeriesId

    // 2. Filter canonical units to only those belonging to primarySeries
    const seriesUnits = canonicalUnits.filter((u) => {
      const c = window.SharedClassSync ? window.SharedClassSync.toCanonicalUnit(u) : null
      return (c?.series || "smart-phonics") === primarySeries
    })

    if (seriesUnits.length < canonicalUnits.length) {
      console.info(`[Word-Tac-Toe] Scoped to "${primarySeries}". Filtered out ${canonicalUnits.length - seriesUnits.length} unit(s) belonging to other series.`)
    }

    selectedUnitKeys.clear()
    seriesUnits.forEach((u) => {
      const ttValue = window.SharedClassSync ? window.SharedClassSync.toTicTacToe(u) : u
      if (ttValue) {
        selectedUnitKeys.add(ttValue)
      }
    })
    if (selectedUnitKeys.size === 0) {
      currentActiveLevelKey = "level1"
    } else {
      const firstUnit = Array.from(selectedUnitKeys)[0]
      const info = getUnitData(firstUnit)
      if (info?.levelKey) currentActiveLevelKey = info.levelKey
    }

    renderWordSelectionUI()
    syncUrlParameters()
  }

  function initScheduleControls() {
    const container = document.getElementById("save-set-days-container")
    const startTimeInput = document.getElementById("save-set-start-time")
    const endTimeInput = document.getElementById("save-set-end-time")
    if (!container || !saveSetNameInput) return

    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    container.innerHTML = ""
    days.forEach((day) => {
      const label = document.createElement("label")
      label.style.cssText = "display: inline-flex; align-items: center; gap: 2px; font-size: 0.75rem; cursor: pointer;"
      const chk = document.createElement("input")
      chk.type = "checkbox"
      chk.value = day
      chk.className = "save-set-day-chk"
      label.appendChild(chk)
      label.appendChild(document.createTextNode(day))
      container.appendChild(label)
    })

    saveSetNameInput.addEventListener("input", () => {
      if (typeof window.SharedClassSync !== "undefined") {
        const sched = window.SharedClassSync.parseScheduleFromName(saveSetNameInput.value)
        if (sched) {
          if (startTimeInput) startTimeInput.value = sched.startTime
          if (endTimeInput) endTimeInput.value = sched.endTime
          container.querySelectorAll(".save-set-day-chk").forEach((chk) => {
            chk.checked = sched.days.includes(chk.value)
          })
        }
      }
    })
  }

  function handleSaveSet() {
    const setName = saveSetNameInput.value.trim()
    if (!setName) {
      showSnackbar("Please enter a name for the list.")
      return
    }

    const currentPlayerNames = gameState.setup.players.map((p) => p.name)
    if (currentPlayerNames.length === 0) {
      showSnackbar("Please add players before saving a list.")
      return
    }

    const sets = getPlayerSets()
    sets[setName] = currentPlayerNames
    setPlayerSets(sets)

    currentLoadedSetName = setName

    // Save schedule & current units in SharedClassSync
    if (typeof window.SharedClassSync !== "undefined") {
      const startTimeInput = document.getElementById("save-set-start-time")
      const endTimeInput = document.getElementById("save-set-end-time")
      const dayChks = document.querySelectorAll(".save-set-day-chk:checked")
      const selectedDays = Array.from(dayChks).map((c) => c.value)

      const selected = Array.from(selectedUnitKeys)
      const canonicals = selected.map((s) => window.SharedClassSync.toCanonicalUnit(s)?.id).filter(Boolean)

      const sched = {
        days: selectedDays.length > 0 ? selectedDays : window.SharedClassSync.parseScheduleFromName(setName).days,
        startTime: startTimeInput?.value || "15:00",
        endTime: endTimeInput?.value || "16:00"
      }

      let profiles = {}
      try {
        profiles = JSON.parse(localStorage.getItem(window.SharedClassSync.SHARED_CLASS_PROFILES_KEY) || "{}")
      } catch {}

      profiles[setName] = {
        schedule: sched,
        units: canonicals,
        curriculumId: activeSeriesId,
        updatedAt: Date.now()
      }
      localStorage.setItem(window.SharedClassSync.SHARED_CLASS_PROFILES_KEY, JSON.stringify(profiles))
      window.SharedClassSync.syncUpstash(window.SharedClassSync.SHARED_CLASS_PROFILES_KEY, profiles)
    }

    saveSetNameInput.value = "" // Clear the input
    populateSetsDialog() // Refresh the list
  }

  function handleLoadSet(setName, preferActiveSession = false) {
    const sets = getPlayerSets()
    const rawNames = sets[setName]

    if (!rawNames) return

    currentLoadedSetName = setName

    const playerNames = (preferActiveSession && window.SharedClassSync?.resolveClassRoster)
      ? window.SharedClassSync.resolveClassRoster(setName, rawNames)
      : rawNames

    const newPlayers = playerNames.map((name, index) => ({
      id: Date.now() + index,
      name: name,
    }))

    gameState = {
      ...gameState,
      setup: { ...gameState.setup, players: assignRandomColors(newPlayers, true) },
    }

    renderNameInputs()
    updatePlayerButtonsState()
    updateMatchLengthDefault()
    updateRotatingStartersDefault()
    updateEqualRoundsDefault()

    // Also load unit settings for this class if available BEFORE saving settings
    if (typeof window.SharedClassSync !== "undefined") {
      try {
        const rawProfiles = localStorage.getItem(window.SharedClassSync.SHARED_CLASS_PROFILES_KEY)
        const profiles = rawProfiles ? JSON.parse(rawProfiles) : {}
        if (profiles[setName] && Array.isArray(profiles[setName].units) && profiles[setName].units.length > 0) {
          applyUnitsToTicTacToe(profiles[setName].units, profiles[setName].curriculumId)
        }
      } catch (e) {
        console.warn("Error applying units for loaded set:", e)
      }
    }

    playerSetsDialog.close()
    validatePlayerNames()
    saveSettings()
  }

  function handleDeleteSet(setName) {
    if (!confirm(`Are you sure you want to delete the list "${setName}"?`)) {
      return
    }
    const sets = getPlayerSets()
    delete sets[setName]
    setPlayerSets(sets)
    populateSetsDialog() // Refresh the list
  }

  // --- INITIALIZE and ATTACH LISTENERS ---

  showStatsBtn.addEventListener("click", () => {
    gameState.currentView = "stats"
    render()
  })

  randomizeBoardSizeBtn.addEventListener("click", handleRandomizeBoardSize)

  backToSetupBtn.addEventListener("click", () => {
    gameState.currentView = "setup"
    render()
  })

  resetSettingsBtn.addEventListener("click", resetSettings)
  if (resetUnitsBtn) {
    resetUnitsBtn.addEventListener("click", handleResetUnits)
  }
  if (toggleLevelAllBtn) {
    toggleLevelAllBtn.addEventListener("click", toggleLevelAll)
  }
  startGameBtn.addEventListener("click", () => initGame(true))
  randomizePlayerOrderBtn_setup.addEventListener("click", randomizePlayerOrder)
  pronounceWordsToggle.addEventListener("change", () => {
    updateApiFieldVisibility()
    saveSettings()
  })
  muteSoundsToggle.addEventListener("change", () => {
    gameState = { ...gameState, isMuted: muteSoundsToggle.checked }
    if (gameState.isMuted) {
      stopAllTurnVoices()
    }
    updatePronunciationToggleState()
    saveSettings()
  })
  if (survivorRotatingStarterToggle) {
    survivorRotatingStarterToggle.addEventListener("change", () => {
      userSetSurvivorRotatingStarters = true
      saveSettings()
    })
  }
  if (survivorEqualRoundsToggle) {
    survivorEqualRoundsToggle.addEventListener("change", () => {
      userSetSurvivorEqualRounds = true
      saveSettings()
    })
  }
  if (fairPlayToggle && fairPlayToggle !== survivorEqualRoundsToggle) {
    fairPlayToggle.addEventListener("change", () => {
      userSetSurvivorEqualRounds = true
      saveSettings()
    })
  }
  if (conquestBlockPointsToggle) {
    conquestBlockPointsToggle.addEventListener("change", () => {
      saveSettings()
    })
  }
  if (conquestRotatingStarterToggle) {
    conquestRotatingStarterToggle.addEventListener("change", () => {
      userSetConquestRotatingStarters = true
      saveSettings()
    })
  }
  if (conquestEqualRoundsToggle) {
    conquestEqualRoundsToggle.addEventListener("change", () => {
      userSetConquestEqualRounds = true
      saveSettings()
    })
  }
  if (stealthRotatingStarterToggle) {
    stealthRotatingStarterToggle.addEventListener("change", () => {
      userSetStealthRotatingStarters = true
      saveSettings()
    })
  }
  if (stealthEqualRoundsToggle) {
    stealthEqualRoundsToggle.addEventListener("change", () => {
      userSetStealthEqualRounds = true
      saveSettings()
    })
  }
  addPlayerBtn.addEventListener("click", handleAddPlayer)
  playerNamesContainer.addEventListener("click", handleRemovePlayer)
  gridSizeInput.addEventListener("input", () => {
    syncSliders()
    updateMatchLengthDefault()
    saveSettings()
  })
  matchLengthInput.addEventListener("input", () => {
    matchLengthValue.textContent = matchLengthInput.value
    saveSettings()
  })

  randomizeGameModeBtn.addEventListener("click", handleRandomizeGameMode)

  gameModeSelector.addEventListener("click", (e) => {
    const clickedButton = e.target.closest("button")
    if (!clickedButton) return

    const previousMode = gameModeSelector.querySelector("button.selected")?.dataset.mode
    const gameMode = clickedButton.dataset.mode
    updateGameModeHint(gameMode)

    updateMatchLengthDefault(previousMode)

    saveSettings()
  })

  if (bookSelect) {
    bookSelect.addEventListener("change", () => {
      handleSeriesChange(bookSelect.value)
    })
  }

  playerNamesContainer.addEventListener("dragover", (e) => {
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move"
    }
    const draggingEl = playerNamesContainer.querySelector(".dragging")
    const targetEl = e.target.closest(".player-field-wrapper")

    // Clear previous highlights from all other fields
    playerNamesContainer.querySelectorAll(".drop-target").forEach((el) => {
      el.classList.remove("drop-target")
    })

    // Add highlight to the field we are currently over
    if (targetEl && targetEl !== draggingEl) {
      targetEl.classList.add("drop-target")
    }
  })

  playerNamesContainer.addEventListener("drop", (e) => {
    e.preventDefault()
    const draggingEl = playerNamesContainer.querySelector(".dragging")
    const dropTarget = playerNamesContainer.querySelector(".drop-target")

    // If we aren't dropping on a valid target, cancel the drop
    if (!draggingEl || !dropTarget) {
      if (dropTarget) dropTarget.classList.remove("drop-target")
      return
    }

    dropTarget.classList.remove("drop-target")

    const fromId = String(draggingEl.dataset.playerId)
    const toId = String(dropTarget.dataset.playerId)

    if (fromId === toId) return // Dropped on itself

    const fromIndex = gameState.setup.players.findIndex((p) => String(p.id) === fromId)
    const toIndex = gameState.setup.players.findIndex((p) => String(p.id) === toId)

    if (fromIndex !== -1 && toIndex !== -1) {
      movePlayerTo(fromIndex, toIndex)
    }
  })

  manageSetsBtn.addEventListener("click", () => {
    initScheduleControls()
    populateSetsDialog()
    playerSetsDialog.showModal()
  })

  closeSetsDialogBtn.addEventListener("click", () => {
    playerSetsDialog.close()
  })

  if (manageBooksBtn && manageBooksDialog) {
    manageBooksBtn.addEventListener("click", () => {
      renderManageBooksList()
      manageBooksDialog.showModal()
    })
  }

  if (closeManageBooksBtn && manageBooksDialog) {
    closeManageBooksBtn.addEventListener("click", () => {
      manageBooksDialog.close()
    })
  }

  if (doneManageBooksBtn && manageBooksDialog) {
    doneManageBooksBtn.addEventListener("click", () => {
      manageBooksDialog.close()
    })
  }

  saveSetBtn.addEventListener("click", handleSaveSet)

  // --- EVENT LISTENERS for between rounds player order setup ---

  const randomizeOrderBtn_game = document.getElementById(
    "randomizeOrderBtn_game",
  )
  const startGameBtn_game = document.getElementById("startGameBtn_game")

  randomizeOrderBtn_game.addEventListener("click", randomizeTurnOrder)
  startGameBtn_game.addEventListener("click", () => initGame(false))

  const handleDragStart = (e) => {
    if (isOrderLocked) return
    e.target.classList.add("dragging")
    e.dataTransfer.setData("text/plain", e.target.dataset.index)
  }
  const handleDragEnd = (e) => {
    e.target.classList.remove("dragging")
  }

  // Re-wire drag and drop to the player info list
  playerInfoList.addEventListener("dragover", (e) => {
    // Can't reorder if the game is locked/in progress
    if (isOrderLocked) return
    e.preventDefault()

    const draggingEl = playerInfoList.querySelector(
      ".player-info-block.dragging",
    )
    const targetEl = e.target.closest(".player-info-block")

    // Clear previous highlights from all other cards
    playerInfoList.querySelectorAll(".drop-target").forEach((el) => {
      el.classList.remove("drop-target")
    })

    // Add highlight to the card we are currently hovering over
    if (targetEl && targetEl !== draggingEl) {
      targetEl.classList.add("drop-target")
    }
  })

  playerInfoList.addEventListener("drop", (e) => {
    if (isOrderLocked) return
    e.preventDefault()

    const fromIndex = parseInt(e.dataTransfer.getData("text/plain"))
    const dropTarget = playerInfoList.querySelector(
      ".player-info-block.drop-target",
    )

    // If we aren't dropping on a valid target, cancel the drop
    if (!dropTarget) return

    dropTarget.classList.remove("drop-target")

    const toIndex = Array.from(playerInfoList.children).indexOf(dropTarget)

    // Don't do anything if we are dropping in the same place
    if (fromIndex === toIndex) return

    // Move the items in all three data arrays to keep them synced
    const [nameToMove] = gameState.playerNames.splice(fromIndex, 1)
    const [colorToMove] = gameState.playerColors.splice(fromIndex, 1)
    const [radiusToMove] = gameState.playerRadii.splice(fromIndex, 1)
    const [playerToMove] = gameState.players.splice(fromIndex, 1)

    gameState.playerNames.splice(toIndex, 0, nameToMove)
    gameState.playerColors.splice(toIndex, 0, colorToMove)
    gameState.playerRadii.splice(toIndex, 0, radiusToMove)
    gameState.players.splice(toIndex, 0, playerToMove)

    // Re-render the player info cards to show the final new order
    renderPlayerInfo()
    saveActiveSessionPlayers(gameState.playerNames)
  })

  // Click or press Enter/Space on the active player's box to announce their turn
  playerInfoList.addEventListener("click", (e) => {
    if (gameState.currentView !== "game") return
    const block = e.target.closest(".player-info-block")
    if (!block) return
    const playerIndex = parseInt(block.dataset.index, 10)
    if (isNaN(playerIndex) || playerIndex !== gameState.currentPlayer) return
    playPlayerTurnAudio(playerIndex)
  })

  playerInfoList.addEventListener("keydown", (e) => {
    if (gameState.currentView !== "game") return
    if (e.key === "Enter" || e.key === " ") {
      const block = e.target.closest(".player-info-block")
      if (!block) return
      const playerIndex = parseInt(block.dataset.index, 10)
      if (isNaN(playerIndex) || playerIndex !== gameState.currentPlayer) return
      e.preventDefault()
      playPlayerTurnAudio(playerIndex)
    }
  })

  if (typeof initSmartPhonicsWordBank === "function") {
    await initSmartPhonicsWordBank()
  }

  loadSettings()
  updateApiFieldVisibility()

  // Upstash Config and Sync UI event listeners
  const upstashUrlInput = document.getElementById("upstash-url")
  const upstashTokenInput = document.getElementById("upstash-token")
  const saveSyncBtn = document.getElementById("save-sync-btn")
  const syncStatus = document.getElementById("sync-status")

  if (upstashUrlInput && upstashTokenInput && saveSyncBtn) {
    const savedUrl = localStorage.getItem(UPSTASH_URL_KEY)
    const savedToken = localStorage.getItem(UPSTASH_TOKEN_KEY)
    if (savedUrl) upstashUrlInput.value = savedUrl
    if (savedToken) upstashTokenInput.value = savedToken

    saveSyncBtn.addEventListener("click", async () => {
      let url = upstashUrlInput.value.trim()
      if (url.endsWith("/")) {
        url = url.slice(0, -1)
      }
      const token = upstashTokenInput.value.trim()

      if (!url || !token) {
        if (syncStatus) {
          syncStatus.textContent = "Please enter both URL and Token"
          syncStatus.className = "sync-status-msg error"
        }
        return
      }

      if (syncStatus) {
        syncStatus.textContent = "Connecting & Syncing..."
        syncStatus.className = "sync-status-msg"
      }
      saveSyncBtn.disabled = true

      try {
        const testRes = await fetch(`${url}/get/${SHARED_ACTIVE_PLAYERS_KEY}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (testRes.ok) {
          localStorage.setItem(UPSTASH_URL_KEY, url)
          localStorage.setItem(UPSTASH_TOKEN_KEY, token)
          window.SharedClassSync?.saveCredentials?.(url, token)

          if (syncStatus) {
            syncStatus.textContent = "Connected & synced!"
            syncStatus.className = "sync-status-msg success"
          }
          saveSyncBtn.disabled = false

          // Run a full sync to load whatever is in the DB
          await syncWithUpstashOnLoad()

          setTimeout(() => {
            updateSyncFieldVisibility()
          }, 1500)
        } else {
          throw new Error("Invalid credentials")
        }
      } catch (err) {
        console.error("Upstash connection failed:", err)
        if (syncStatus) {
          syncStatus.textContent = "Failed. Check credentials."
          syncStatus.className = "sync-status-msg error"
        }
        saveSyncBtn.disabled = false
      }
    })
  }

  window.addEventListener("resize", () => {
    if (gameState.currentView === "game" || gameState.currentView === "reorder") {
      const firstCell = gameBoard.querySelector(".cell")
      if (firstCell) {
        adjustCellWordFontSize()
      }
    }
  })

  // Trigger sync on load if credentials exist
  syncWithUpstashOnLoad()
})
