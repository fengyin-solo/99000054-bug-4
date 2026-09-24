import { defineStore } from 'pinia'
import { ref } from 'vue'
import { boardApi, columnApi, cardApi } from '../api/index.js'

export const useBoardStore = defineStore('board', () => {
  const boards = ref([])
  const currentBoard = ref(null)
  const columns = ref([])
  const cards = ref({}) // keyed by columnId -> [cards]
  const loading = ref(false)
  const loadError = ref(null) // board-level load failure message
  const cardErrors = ref({}) // keyed by columnId -> error message

  // Guards against stale responses when switching boards quickly:
  // only the latest loadBoard call is allowed to commit state.
  let loadToken = 0

  // Board actions
  async function fetchBoards() {
    loading.value = true
    try {
      const res = await boardApi.list()
      boards.value = res.data
    } finally {
      loading.value = false
    }
  }

  async function createBoard(name, description) {
    const res = await boardApi.create(name, description)
    boards.value.unshift(res.data)
    return res.data
  }

  async function deleteBoard(id) {
    await boardApi.delete(id)
    boards.value = boards.value.filter(b => b.id !== id)
  }

  // Load everything the board page needs for the given board id.
  // Clears any previous board's columns/cards/errors first so the page
  // never shows data that doesn't belong to the current URL.
  async function loadBoard(boardId) {
    const token = ++loadToken
    const isCurrent = () => token === loadToken

    clearBoard()
    loading.value = true
    try {
      const boardRes = await boardApi.get(boardId)
      if (!isCurrent()) return
      currentBoard.value = boardRes.data

      const colsRes = await columnApi.list(boardId)
      if (!isCurrent()) return
      columns.value = colsRes.data
      cards.value = {}
      for (const col of colsRes.data) {
        cards.value[col.id] = []
      }

      // Cards are loaded per column; a single failing column must not
      // take down the whole board (see fetchAllCards).
      await fetchAllCards()
    } catch (err) {
      if (!isCurrent()) return
      clearBoard()
      loadError.value = err.response?.data?.error || 'Failed to load board'
    } finally {
      if (isCurrent()) loading.value = false
    }
  }

  // Column actions
  async function fetchColumns(boardId) {
    loading.value = true
    try {
      const res = await columnApi.list(boardId)
      columns.value = res.data
      // Initialize cards map, dropping columns that no longer exist
      const next = {}
      for (const col of res.data) {
        next[col.id] = cards.value[col.id] || []
      }
      cards.value = next
      // Drop card errors for columns that no longer exist
      const nextErrors = {}
      for (const col of res.data) {
        if (cardErrors.value[col.id]) nextErrors[col.id] = cardErrors.value[col.id]
      }
      cardErrors.value = nextErrors
    } finally {
      loading.value = false
    }
  }

  async function addColumn(boardId, name) {
    const res = await columnApi.create(boardId, name)
    columns.value.push(res.data)
    cards.value[res.data.id] = []
    return res.data
  }

  async function renameColumn(colId, name) {
    const res = await columnApi.update(colId, { name })
    const idx = columns.value.findIndex(c => c.id === colId)
    if (idx !== -1) columns.value[idx] = res.data
    return res.data
  }

  async function deleteColumn(colId) {
    await columnApi.delete(colId)
    columns.value = columns.value.filter(c => c.id !== colId)
    delete cards.value[colId]
    delete cardErrors.value[colId]
  }

  async function reorderColumn(colId, newPosition) {
    const res = await columnApi.update(colId, { position: newPosition })
    // Refresh columns to get correct order
    if (currentBoard.value) {
      await fetchColumns(currentBoard.value.id)
    }
    return res.data
  }

  // Card actions
  async function fetchCards(columnId) {
    try {
      const res = await cardApi.list(columnId)
      cards.value[columnId] = res.data
      delete cardErrors.value[columnId]
      return res.data
    } catch (err) {
      cardErrors.value[columnId] = err.response?.data?.error || 'Failed to load cards'
      throw err
    }
  }

  async function fetchAllCards() {
    // Fetch cards for all columns in parallel, tolerating per-column
    // failures: a failed column keeps its error entry (with a retry
    // entry point in the UI) instead of blanking the whole board.
    const cols = columns.value
    await Promise.all(cols.map(async (col) => {
      try {
        const res = await cardApi.list(col.id)
        cards.value[col.id] = res.data
        delete cardErrors.value[col.id]
      } catch (err) {
        cardErrors.value[col.id] = err.response?.data?.error || 'Failed to load cards'
      }
    }))
  }

  async function addCard(columnId, data) {
    const res = await cardApi.create(columnId, data)
    if (!cards.value[columnId]) cards.value[columnId] = []
    cards.value[columnId].push(res.data)
    return res.data
  }

  async function updateCard(cardId, data) {
    const res = await cardApi.update(cardId, data)
    // Update card in the local state
    for (const colId in cards.value) {
      const idx = cards.value[colId].findIndex(c => c.id === cardId)
      if (idx !== -1) {
        cards.value[colId][idx] = res.data
        break
      }
    }
    return res.data
  }

  async function deleteCard(cardId) {
    await cardApi.delete(cardId)
    for (const colId in cards.value) {
      cards.value[colId] = cards.value[colId].filter(c => c.id !== cardId)
    }
  }

  async function moveCard(cardId, targetColumnId, position) {
    const res = await cardApi.move(cardId, targetColumnId, position)
    // Remove card from old column and add to new column
    let movedCard = null
    for (const colId in cards.value) {
      const idx = cards.value[colId].findIndex(c => c.id === cardId)
      if (idx !== -1) {
        movedCard = cards.value[colId].splice(idx, 1)[0]
        break
      }
    }
    if (movedCard) {
      movedCard.column_id = targetColumnId
      movedCard.position = position
      if (!cards.value[targetColumnId]) cards.value[targetColumnId] = []
      // Insert at position
      cards.value[targetColumnId].splice(position, 0, movedCard)
    }
    return res.data
  }

  function clearBoard() {
    currentBoard.value = null
    columns.value = []
    cards.value = {}
    loadError.value = null
    cardErrors.value = {}
  }

  return {
    boards, currentBoard, columns, cards, loading, loadError, cardErrors,
    fetchBoards, createBoard, deleteBoard, loadBoard,
    fetchColumns, addColumn, renameColumn, deleteColumn, reorderColumn,
    fetchCards, fetchAllCards, addCard, updateCard, deleteCard, moveCard,
    clearBoard
  }
})
