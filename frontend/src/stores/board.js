import { defineStore } from 'pinia'
import { ref } from 'vue'
import { boardApi, columnApi, cardApi } from '../api/index.js'

export const useBoardStore = defineStore('board', () => {
  // Boards list state (Home page)
  const boards = ref([])
  const loading = ref(false)

  // Current board view state (Board page)
  const currentBoard = ref(null)
  const columns = ref([])
  const cards = ref({}) // keyed by columnId -> [cards]
  const boardLoading = ref(false)
  const boardError = ref('')
  // per-column card load state: columnId -> 'loading' | 'success' | 'error'
  const cardLoadState = ref({})
  const cardLoadError = ref({}) // columnId -> error message

  // Bumped on every (re)load / reset so stale responses from a previous
  // board can never overwrite the board currently shown in the URL.
  let activeLoadId = 0

  // Board list actions
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

  // Board view actions

  // Reset every piece of board-view state. The bumped load id also
  // invalidates any in-flight load that belongs to the previous board.
  function resetBoard() {
    activeLoadId += 1
    currentBoard.value = null
    columns.value = []
    cards.value = {}
    cardLoadState.value = {}
    cardLoadError.value = {}
    boardLoading.value = false
    boardError.value = ''
  }

  // Fetch board meta + columns + all cards for a board.
  // Board/columns failure -> board-level error with retry entry.
  // A single column's cards failing -> that column shows its own retry,
  // the rest of the board stays usable.
  async function loadBoard(boardId) {
    const loadId = ++activeLoadId

    boardLoading.value = true
    boardError.value = ''
    currentBoard.value = { id: boardId, name: 'Loading...' }
    columns.value = []
    cards.value = {}
    cardLoadState.value = {}
    cardLoadError.value = {}

    try {
      // Board meta and columns are both required to render the page.
      const [boardRes, columnsRes] = await Promise.all([
        boardApi.get(boardId).catch(err => ({ __error: err })),
        columnApi.list(boardId)
      ])

      if (loadId !== activeLoadId) return // navigated away / switched board

      // Resolve the name straight from the server; fall back to the
      // cached boards list, then to a neutral label.
      if (!boardRes.__error) {
        currentBoard.value = boardRes.data
      } else {
        const cached = boards.value.find(b => b.id === boardId)
        currentBoard.value = cached
          ? { ...cached }
          : { id: boardId, name: `Board #${boardId}` }
      }

      columns.value = columnsRes.data
      for (const col of columnsRes.data) {
        cards.value[col.id] = []
        cardLoadState.value[col.id] = 'loading'
      }

      await loadCardsForColumns(columnsRes.data.map(col => col.id), loadId)
    } catch (err) {
      if (loadId !== activeLoadId) return
      const status = err.response?.status
      boardError.value =
        status === 404
          ? 'Board not found or you no longer have access to it.'
          : 'Failed to load board. Please try again.'
      // Drop the columns/cards of the failed load, but keep the header
      // showing the id of the board the URL points to.
      columns.value = []
      cards.value = {}
      cardLoadState.value = {}
      cardLoadError.value = {}
    } finally {
      if (loadId === activeLoadId) {
        boardLoading.value = false
      }
    }
  }

  // Load cards for the given columns in parallel; failures are tracked
  // per column instead of rejecting the whole board load.
  async function loadCardsForColumns(columnIds, loadId = activeLoadId) {
    if (!columnIds.length) return
    for (const id of columnIds) {
      cardLoadState.value[id] = 'loading'
      cardLoadError.value[id] = ''
    }

    const settled = await Promise.allSettled(
      columnIds.map(id => cardApi.list(id))
    )

    if (loadId !== activeLoadId) return // switched board / reset meanwhile

    settled.forEach((result, i) => {
      const colId = columnIds[i]
      if (result.status === 'fulfilled') {
        cards.value[colId] = result.value.data
        cardLoadState.value[colId] = 'success'
        cardLoadError.value[colId] = ''
      } else {
        // Keep previously visible cards (if any) out of the way and let
        // the column surface a retry affordance.
        cards.value[colId] = []
        cardLoadState.value[colId] = 'error'
        cardLoadError.value[colId] = 'Failed to load cards'
      }
    })
  }

  // Retry only the cards of one failed column.
  async function retryColumnCards(columnId) {
    const loadId = activeLoadId
    cardLoadState.value[columnId] = 'loading'
    cardLoadError.value[columnId] = ''
    try {
      const res = await cardApi.list(columnId)
      if (loadId !== activeLoadId) return
      cards.value[columnId] = res.data
      cardLoadState.value[columnId] = 'success'
    } catch (err) {
      if (loadId !== activeLoadId) return
      cardLoadState.value[columnId] = 'error'
      cardLoadError.value[columnId] = 'Failed to load cards'
    }
  }

  // Column actions
  async function addColumn(boardId, name) {
    const res = await columnApi.create(boardId, name)
    columns.value.push(res.data)
    cards.value[res.data.id] = []
    cardLoadState.value[res.data.id] = 'success'
    cardLoadError.value[res.data.id] = ''
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
    delete cardLoadState.value[colId]
    delete cardLoadError.value[colId]
  }

  // Refresh just the column order after a drag; keeps loaded cards intact.
  async function refreshColumns(boardId) {
    const res = await columnApi.list(boardId)
    columns.value = res.data
    for (const col of res.data) {
      if (!(col.id in cards.value)) {
        cards.value[col.id] = []
        cardLoadState.value[col.id] = 'success'
      }
    }
  }

  // Card actions
  async function addCard(columnId, data) {
    const res = await cardApi.create(columnId, data)
    if (!cards.value[columnId]) cards.value[columnId] = []
    cards.value[columnId].push(res.data)
    // A successful write proves the column is reachable again.
    cardLoadState.value[columnId] = 'success'
    cardLoadError.value[columnId] = ''
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

  return {
    // state
    boards, loading,
    currentBoard, columns, cards,
    boardLoading, boardError, cardLoadState, cardLoadError,
    // board list actions
    fetchBoards, createBoard, deleteBoard,
    // board view actions
    loadBoard, resetBoard, loadCardsForColumns, retryColumnCards,
    refreshColumns,
    // column actions
    addColumn, renameColumn, deleteColumn,
    // card actions
    addCard, updateCard, deleteCard, moveCard
  }
})
