(function () {
  const INLINE_SELECTOR = ".alang-inline";
  const FLATTENABLE_INLINE_SELECTOR = "a, b, strong, em, i, u, mark, small, sup, sub";
  const LETTER_PATTERN = /[\p{L}\p{M}]/u;
  const WORD_PATTERN = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/u;
  const WORD_MATCH_PATTERN = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
  const MAX_SELECTION_LENGTH = 220;
  const MAX_MERGE_CHARS = 48;
  const MAX_MERGE_WORDS = 4;
  const DEFAULT_TRANSLATION_COLOR = "#19b22a";
  const DEFAULT_HIGHLIGHT_COLOR = "yellow";
  const HIGHLIGHT_COLOR_VALUES = {
    yellow: "rgba(255, 236, 128, 0.62)",
    green: "rgba(187, 247, 208, 0.68)",
    blue: "rgba(191, 219, 254, 0.7)",
    pink: "rgba(251, 207, 232, 0.72)",
    purple: "rgba(221, 214, 254, 0.72)"
  };

  const annotations = new Set();
  let isActive = false;
  let pageWasNormalized = false;
  let currentAnnotation = null;
  let suppressNextClick = false;
  let annotationSequence = 0;

  initialize();
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("mouseup", onDocumentMouseUp, true);
  document.addEventListener("keydown", onGlobalKeyDown, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === "READLINGO_SET_ACTIVE") {
      isActive = Boolean(message.active);
      syncActiveUiState();
      if (isActive) {
        normalizeInlineFormatting();
      } else {
        clearAllAnnotations();
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
        }

        if (pageWasNormalized) {
          window.location.reload();
          return;
        }
      }

      sendResponse({ ok: true });
    }

    if (message.type === "READLINGO_SET_TRANSLATION_COLOR") {
      applyTranslationColorToAnnotations(message.color);
      sendResponse({ ok: true });
    }

    if (message.type === "READLINGO_SET_HIGHLIGHT_COLOR") {
      applyHighlightColorToAnnotations(message.color);
      sendResponse({ ok: true });
    }
  });

  async function initialize() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_TAB_STATUS" });
      isActive = Boolean(response?.ok && response.active);
      syncActiveUiState();
      if (isActive) {
        normalizeInlineFormatting();
      }
    } catch (error) {
      isActive = false;
      syncActiveUiState();
    }
  }

  function syncActiveUiState() {
    document.documentElement.classList.toggle("alang-active", isActive);
  }

  function onDocumentClick(event) {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    if (!isActive) {
      return;
    }

    const liveSelection = window.getSelection();
    if (liveSelection && !liveSelection.isCollapsed) {
      return;
    }

    const target = event.target;

    const existingAnnotation = findAnnotationFromNode(target);
    if (existingAnnotation) {
      const mergeResult = mergeNearbyAnnotations(existingAnnotation);
      activateAnnotation(mergeResult.annotation);
      if (mergeResult.changed) {
        retranslateAnnotation(mergeResult.annotation);
        return;
      }

      return;
    }

    const interactiveAncestor = target instanceof Element
      ? target.closest("a, button, input, textarea, select, label, summary, audio, video, [role='button']")
      : null;

    if (interactiveAncestor) {
      return;
    }

    const range = getWordRangeFromPoint(event.clientX, event.clientY);
    if (!range) {
      return;
    }

    const text = sanitizeText(range.toString());
    if (!WORD_PATTERN.test(text)) {
      return;
    }

    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }

    if (event.shiftKey && currentAnnotation) {
      if (tryExpandAnnotation(range, { forceSequence: true })) {
        retranslateAnnotation(mergeNearbyAnnotations(currentAnnotation).annotation);
      }
      return;
    }

    if (currentAnnotation && tryExpandAnnotation(range, { adjacentOnly: true })) {
      retranslateAnnotation(mergeNearbyAnnotations(currentAnnotation).annotation);
      return;
    }

    if (tryExpandNearestAnnotation(range, { adjacentOnly: true })) {
      retranslateAnnotation(mergeNearbyAnnotations(currentAnnotation).annotation);
      return;
    }

    const contextSnapshot = captureContextSnapshot(range, text);
    const annotation = mountAnnotation(range, text, contextSnapshot);
    retranslateAnnotation(mergeNearbyAnnotations(annotation).annotation);
  }

  function onDocumentMouseUp(event) {
    if (!isActive) {
      return;
    }

    const target = event.target;
    if (isALangNode(target)) {
      return;
    }

    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return;
      }

      const range = getNormalizedSelectionRange(selection);
      if (!range) {
        return;
      }

      const selectedText = getRangePlainText(range);
      if (!selectedText || selectedText.length > MAX_SELECTION_LENGTH) {
        return;
      }

      if (!isSelectionRangeEligible(range, selectedText)) {
        return;
      }

      selection.removeAllRanges();
      suppressNextClick = true;
      const contextSnapshot = captureContextSnapshot(range, selectedText);
      const annotation = mountAnnotation(range, selectedText, contextSnapshot);
      retranslateAnnotation(mergeNearbyAnnotations(annotation).annotation);
    }, 0);
  }

  function onGlobalKeyDown(event) {
    if (!currentAnnotation?.selection) {
      return;
    }

    if (event.key === "Escape") {
      clearAllAnnotations();
      return;
    }

    if (event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      handleSave(undefined, currentAnnotation);
      return;
    }

    if (event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      handleSpeak(undefined, currentAnnotation);
    }
  }

  function mountAnnotation(range, rawTextOverride = "", contextSnapshot = null) {
    const extracted = range.extractContents();
    replaceALangNodesWithPlainText(extracted, { removeAnnotations: true });
    const originalContent = extracted.cloneNode(true);
    const usesComplexWrapper = fragmentNeedsComplexWrapper(extracted);
    const root = document.createElement(usesComplexWrapper ? "span" : "ruby");
    const annotationId = String(++annotationSequence);
    root.dataset.alangId = annotationId;
    applyAnnotationColors(root);
    root.className = usesComplexWrapper
      ? "alang-inline is-complex-selection"
      : "alang-inline";

    const translationNode = document.createElement(usesComplexWrapper ? "span" : "rt");
    translationNode.className = usesComplexWrapper
      ? "alang-inline-translation is-floating"
      : "alang-inline-translation";
    translationNode.textContent = "Translating...";

    const actions = document.createElement("span");
    actions.className = "alang-inline-actions";
    actions.innerHTML = `
      <button type="button" data-role="save" title="Save" aria-label="Save">💾</button>
      <button type="button" data-role="speak" title="Listen" aria-label="Listen">🔊</button>
      <button type="button" data-role="refresh" title="Refresh translation" aria-label="Refresh translation">Refresh</button>
      <button type="button" data-role="clear" class="ghost" title="Clear this selection" aria-label="Clear this selection">Clear</button>
      <button type="button" data-role="clear-all" class="danger" title="Clear all selections" aria-label="Clear all selections">Clear All</button>
      <button type="button" data-role="close-menu" title="Close menu" aria-label="Close menu">✕</button>
    `;

    const textContainer = document.createElement("span");
    textContainer.className = "alang-inline-text";

    textContainer.appendChild(extracted);

    if (usesComplexWrapper) {
      root.append(translationNode, textContainer, actions);
    } else {
      root.append(textContainer, translationNode, actions);
    }

    range.insertNode(root);

    const saveButton = actions.querySelector('[data-role="save"]');
    const speakButton = actions.querySelector('[data-role="speak"]');
    const refreshButton = actions.querySelector('[data-role="refresh"]');
    const clearButton = actions.querySelector('[data-role="clear"]');
    const clearAllButton = actions.querySelector('[data-role="clear-all"]');
    const closeMenuButton = actions.querySelector('[data-role="close-menu"]');

    const annotation = {
      id: annotationId,
      root,
      translationNode,
      textContainer,
      saveButton,
      speakButton,
      refreshButton,
      clearButton,
      clearAllButton,
      closeMenuButton,
      usesComplexWrapper,
      originalContent,
      rawText: sanitizeText(rawTextOverride || textContainer.textContent || ""),
      contextBlockText: contextSnapshot?.blockText || "",
      contextOffsetHint: typeof contextSnapshot?.selectionStart === "number"
        ? contextSnapshot.selectionStart
        : null,
      selection: null,
      latestTranslation: "",
      requestToken: 0
    };

    saveButton.addEventListener("click", (event) => handleSave(event, annotation));
    speakButton.addEventListener("click", (event) => handleSpeak(event, annotation));
    refreshButton.addEventListener("click", (event) => handleRefresh(event, annotation));
    clearButton.addEventListener("click", (event) => clearAnnotation(event, annotation));
    clearAllButton.addEventListener("click", clearAllAnnotations);
    closeMenuButton.addEventListener("click", (event) => closeAnnotationMenu(event, annotation));

    annotations.add(annotation);
    updateAnnotationLayoutMode(annotation);
    syncSelectionFromAnnotation(annotation, { resetTranslation: true });
    return annotation;
  }

  function tryExpandAnnotation(range, options = {}) {
    return tryExpandSpecificAnnotation(currentAnnotation, range, options);
  }

  function tryExpandNearestAnnotation(range, options = {}) {
    const candidates = [];

    for (const annotation of annotations) {
      const candidate = getAnnotationExpansionCandidate(annotation, range, options);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    candidates.sort((left, right) => left.normalizedLength - right.normalizedLength);

    if (!candidates.length) {
      return false;
    }

    const candidate = candidates[0];
    return expandAnnotationWithRange(candidate.annotation, range, candidate.direction);
  }

  function tryExpandSpecificAnnotation(annotation, range, options = {}) {
    const candidate = getAnnotationExpansionCandidate(annotation, range, options);
    if (!candidate) {
      return false;
    }

    return expandAnnotationWithRange(annotation, range, candidate.direction);
  }

  function expandAnnotationWithRange(annotation, wordRange, direction) {
    const additionRange = createAnnotationExpansionRange(annotation, wordRange, direction);
    const additionText = additionRange.toString();

    if (!additionText) {
      additionRange.detach?.();
      return false;
    }

    additionRange.extractContents();
    additionRange.detach?.();

    if (direction === "before") {
      annotation.rawText = sanitizeText(additionText + annotation.rawText);
      if (typeof annotation.contextOffsetHint === "number") {
        annotation.contextOffsetHint = Math.max(
          0,
          annotation.contextOffsetHint - normalizeContextText(additionText).length
        );
      }
    } else {
      annotation.rawText = sanitizeText(annotation.rawText + additionText);
    }

    annotation.textContainer.textContent = annotation.rawText;
    annotation.originalContent = createTextFragment(annotation.rawText);
    updateAnnotationLayoutMode(annotation);
    annotation.root.parentNode?.normalize();
    currentAnnotation = annotation;
    return true;
  }

  function mergeNearbyAnnotations(annotation) {
    let mergedAnnotation = annotation;
    let changed = false;

    while (mergedAnnotation?.root.isConnected) {
      const neighbor = findMergeableNeighbor(mergedAnnotation);
      if (!neighbor) {
        break;
      }

      const nextAnnotation = mergeAnnotations(mergedAnnotation, neighbor);
      if (!nextAnnotation) {
        break;
      }

      mergedAnnotation = nextAnnotation;
      changed = true;
    }

    return {
      annotation: mergedAnnotation || annotation,
      changed
    };
  }

  function findMergeableNeighbor(annotation) {
    const candidates = [];

    for (const otherAnnotation of annotations) {
      if (otherAnnotation === annotation || !canMergeAnnotations(annotation, otherAnnotation)) {
        continue;
      }

      const bridgeRange = createAnnotationBridgeRange(annotation, otherAnnotation);
      if (!bridgeRange) {
        continue;
      }

      const normalizedLength = getRangePlainText(bridgeRange).length;
      bridgeRange.detach?.();
      candidates.push({ annotation: otherAnnotation, normalizedLength });
    }

    candidates.sort((left, right) => left.normalizedLength - right.normalizedLength);
    return candidates[0]?.annotation || null;
  }

  function mergeAnnotations(leftAnnotation, rightAnnotation) {
    if (!canMergeAnnotations(leftAnnotation, rightAnnotation)) {
      return null;
    }

    const orderedAnnotations = getAnnotationsInDocumentOrder(leftAnnotation, rightAnnotation);
    if (!orderedAnnotations) {
      return null;
    }

    const [leadAnnotation, trailingAnnotation] = orderedAnnotations;
    const mergeRange = document.createRange();
    mergeRange.setStartBefore(leadAnnotation.root);
    mergeRange.setEndAfter(trailingAnnotation.root);
    const mergedText = getRangePlainText(mergeRange);

    if (!mergedText) {
      mergeRange.detach?.();
      return null;
    }

    leadAnnotation.requestToken += 1;
    trailingAnnotation.requestToken += 1;
    trailingAnnotation.latestTranslation = "";
    trailingAnnotation.selection = null;

    mergeRange.extractContents();
    mergeRange.insertNode(leadAnnotation.root);
    mergeRange.detach?.();
    annotations.delete(trailingAnnotation);

    leadAnnotation.rawText = mergedText;
    leadAnnotation.textContainer.textContent = mergedText;
    leadAnnotation.originalContent = createTextFragment(mergedText);
    leadAnnotation.latestTranslation = "";
    leadAnnotation.contextBlockText = leadAnnotation.contextBlockText || trailingAnnotation.contextBlockText;
    leadAnnotation.contextOffsetHint =
      typeof leadAnnotation.contextOffsetHint === "number"
        ? leadAnnotation.contextOffsetHint
        : trailingAnnotation.contextOffsetHint;
    updateAnnotationLayoutMode(leadAnnotation);
    leadAnnotation.root.parentNode?.normalize();
    currentAnnotation = leadAnnotation;
    return leadAnnotation;
  }

  function canMergeAnnotations(leftAnnotation, rightAnnotation) {
    if (
      !leftAnnotation ||
      !rightAnnotation ||
      leftAnnotation === rightAnnotation ||
      !leftAnnotation.root.isConnected ||
      !rightAnnotation.root.isConnected ||
      !areAnnotationsInSameContext(leftAnnotation, rightAnnotation)
    ) {
      return false;
    }

    const bridgeRange = createAnnotationBridgeRange(leftAnnotation, rightAnnotation);
    if (!bridgeRange) {
      return false;
    }

    const isMergeable = isAnnotationBridgeMergeable(bridgeRange);
    bridgeRange.detach?.();
    return isMergeable;
  }

  function getAnnotationExpansionCandidate(annotation, range, options = {}) {
    if (
      !annotation?.root.isConnected ||
      !range ||
      range.collapsed ||
      annotation.root.contains(range.startContainer) ||
      !isRangeInSameContextContainer(range, annotation.root)
    ) {
      return null;
    }

    const direction = getRangeDirectionFromAnnotation(range, annotation);
    if (!direction) {
      return null;
    }

    const additionRange = createAnnotationExpansionRange(annotation, range, direction);
    const additionText = additionRange.toString();
    const normalizedLength = sanitizeText(additionText).length;
    const isAcceptable =
      isMergeAdditionAcceptable(additionText, options) &&
      !rangeContainsALangNode(additionRange);

    additionRange.detach?.();

    if (!isAcceptable) {
      return null;
    }

    return {
      annotation,
      direction,
      normalizedLength
    };
  }

  function createAnnotationExpansionRange(annotation, wordRange, direction) {
    const additionRange = document.createRange();

    if (direction === "before") {
      additionRange.setStart(wordRange.startContainer, wordRange.startOffset);
      additionRange.setEndBefore(annotation.root);
    } else {
      additionRange.setStartAfter(annotation.root);
      additionRange.setEnd(wordRange.endContainer, wordRange.endOffset);
    }

    return additionRange;
  }

  function getRangeDirectionFromAnnotation(range, annotation) {
    const position = annotation.root.compareDocumentPosition(range.startContainer);

    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return "before";
    }

    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return "after";
    }

    return null;
  }

  function rangeContainsALangNode(range) {
    const fragment = range.cloneContents();
    return Boolean(fragment.querySelector?.(INLINE_SELECTOR));
  }

  function isRangeInSameContextContainer(range, node) {
    const annotationContainer = findContextContainer(node);
    const rangeContainer = findContextContainer(range.startContainer);
    return Boolean(annotationContainer && annotationContainer === rangeContainer);
  }

  function areAnnotationsInSameContext(leftAnnotation, rightAnnotation) {
    const leftContainer = findContextContainer(leftAnnotation.root);
    const rightContainer = findContextContainer(rightAnnotation.root);
    return Boolean(leftContainer && leftContainer === rightContainer);
  }

  function getAnnotationsInDocumentOrder(leftAnnotation, rightAnnotation) {
    const position = leftAnnotation.root.compareDocumentPosition(rightAnnotation.root);

    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return [leftAnnotation, rightAnnotation];
    }

    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return [rightAnnotation, leftAnnotation];
    }

    return null;
  }

  function createAnnotationBridgeRange(leftAnnotation, rightAnnotation) {
    const orderedAnnotations = getAnnotationsInDocumentOrder(leftAnnotation, rightAnnotation);
    if (!orderedAnnotations) {
      return null;
    }

    const [leadAnnotation, trailingAnnotation] = orderedAnnotations;
    const bridgeRange = document.createRange();
    bridgeRange.setStartAfter(leadAnnotation.root);
    bridgeRange.setEndBefore(trailingAnnotation.root);
    return bridgeRange;
  }

  function isAnnotationBridgeMergeable(range) {
    const bridgeText = getRangePlainText(range);
    return !LETTER_PATTERN.test(bridgeText);
  }

  function getRangePlainText(range) {
    const fragment = range.cloneContents();
    replaceALangNodesWithPlainText(fragment);
    return sanitizeText(fragment.textContent || "");
  }

  function replaceALangNodesWithPlainText(container, options = {}) {
    const inlineNodes = Array.from(container.querySelectorAll?.(INLINE_SELECTOR) || []);

    for (const inlineNode of inlineNodes) {
      const annotation = findAnnotationById(inlineNode.dataset.alangId);
      const text = annotation?.rawText || inlineNode.querySelector(".alang-inline-text")?.textContent || "";

      if (options.removeAnnotations && annotation) {
        annotation.requestToken += 1;
        annotation.latestTranslation = "";
        annotation.selection = null;
        annotations.delete(annotation);
        if (currentAnnotation === annotation) {
          currentAnnotation = null;
        }
      }

      inlineNode.replaceWith(document.createTextNode(text));
    }
  }

  function isMergeAdditionAcceptable(text, options = {}) {
    if (options.forceSequence) {
      return sanitizeText(text).length > 0;
    }

    const normalized = sanitizeText(text);
    const words = normalized.match(WORD_MATCH_PATTERN) || [];

    if (options.adjacentOnly) {
      return normalized.length > 0 && words.length === 1;
    }

    return normalized.length > 0 && normalized.length <= MAX_MERGE_CHARS && words.length <= MAX_MERGE_WORDS;
  }

  function retranslateAnnotation(annotation = currentAnnotation) {
    if (!annotation) {
      return;
    }

    activateAnnotation(annotation);
    syncSelectionFromAnnotation(annotation, { resetTranslation: true });
    translateAnnotation(annotation);
  }

  async function translateAnnotation(annotation = currentAnnotation) {
    if (!annotation?.root.isConnected) {
      return;
    }

    currentAnnotation = annotation;
    syncSelectionFromAnnotation(annotation);

    if (!annotation.selection?.text) {
      return;
    }

    const token = ++annotation.requestToken;
    setBusy(annotation, "Translating...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        text: annotation.selection.text,
        context: annotation.selection.context
      });

      if (token !== annotation.requestToken || !annotation.root.isConnected) {
        return;
      }

      if (!response?.ok) {
        throw new Error(response?.error || "Could not translate.");
      }

      annotation.latestTranslation = response.result.translation;
      annotation.translationNode.textContent = annotation.latestTranslation;
      annotation.root.classList.remove("is-error");
    } catch (error) {
      if (token !== annotation.requestToken || !annotation.root.isConnected) {
        return;
      }

      annotation.latestTranslation = "";
      annotation.translationNode.textContent = error.message;
      annotation.root.classList.add("is-error");
    } finally {
      if (token === annotation.requestToken) {
        setIdle(annotation);
      }
    }
  }

  async function handleSave(event, annotation = currentAnnotation) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (!annotation?.selection) {
      return;
    }

    activateAnnotation(annotation);

    if (!annotation.latestTranslation) {
      await translateAnnotation(annotation);
      if (!annotation.latestTranslation) {
        return;
      }
    }

    setBusy(annotation, "Saving...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "SAVE_ENTRY",
        entry: {
          text: annotation.selection.text,
          translation: annotation.latestTranslation,
          context: annotation.selection.context,
          pageUrl: annotation.selection.pageUrl,
          pageTitle: annotation.selection.pageTitle
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not save.");
      }

      annotation.translationNode.textContent = `${annotation.latestTranslation} - saved`;
      annotation.root.classList.remove("is-error");
    } catch (error) {
      annotation.translationNode.textContent = error.message;
      annotation.root.classList.add("is-error");
    } finally {
      setIdle(annotation);
    }
  }

  async function handleSpeak(event, annotation = currentAnnotation) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (!annotation?.selection) {
      return;
    }

    activateAnnotation(annotation);

    const utterance = new SpeechSynthesisUtterance(annotation.selection.text);
    const speechSettings = await getSpeechSettings();
    utterance.lang = speechSettings.lang;
    utterance.voice = speechSettings.voice;
    utterance.rate = speechSettings.rate;
    utterance.pitch = speechSettings.pitch;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function handleRefresh(event, annotation = currentAnnotation) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (!annotation?.root.isConnected) {
      return;
    }

    retranslateAnnotation(annotation);
  }

  function clearAllAnnotations(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    for (const annotation of Array.from(annotations)) {
      if (!annotation.root.isConnected) {
        continue;
      }

      annotation.requestToken += 1;
      annotation.latestTranslation = "";
      annotation.selection = null;

      const parent = annotation.root.parentNode;
      if (!parent) {
        continue;
      }

      const restoredContent = annotation.originalContent
        ? annotation.originalContent.cloneNode(true)
        : createTextFragment(annotation.rawText);

      parent.replaceChild(restoredContent, annotation.root);
      parent.normalize();
    }

    annotations.clear();
    currentAnnotation = null;
  }

  function clearAnnotation(event, annotation = currentAnnotation) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (!annotation?.root.isConnected) {
      return;
    }

    annotation.requestToken += 1;
    annotation.latestTranslation = "";
    annotation.selection = null;

    const parent = annotation.root.parentNode;
    if (!parent) {
      return;
    }

    const restoredContent = annotation.originalContent
      ? annotation.originalContent.cloneNode(true)
      : createTextFragment(annotation.rawText);

    parent.replaceChild(restoredContent, annotation.root);
    parent.normalize();
    annotations.delete(annotation);

    if (currentAnnotation === annotation) {
      currentAnnotation = null;
    }
  }

  function closeAnnotationMenu(event, annotation = currentAnnotation) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (annotation?.root.isConnected) {
      annotation.root.classList.remove("is-current");
    }

    if (currentAnnotation === annotation) {
      currentAnnotation = null;
    }
  }

  function activateAnnotation(annotation) {
    if (!annotation) {
      return;
    }

    for (const item of annotations) {
      if (item.root?.isConnected) {
        item.root.classList.toggle("is-current", item === annotation);
      }
    }

    currentAnnotation = annotation;
    syncSelectionFromAnnotation(annotation);
  }

  function syncSelectionFromAnnotation(annotation = currentAnnotation, options = {}) {
    if (!annotation) {
      currentAnnotation = null;
      return;
    }

    updateAnnotationLayoutMode(annotation);
    annotation.selection = {
      text: sanitizeText(annotation.rawText),
      context: deriveAnnotationContext(annotation),
      pageUrl: window.location.href,
      pageTitle: document.title
    };

    if (options.resetTranslation) {
      annotation.latestTranslation = "";
    }
  }

  function deriveAnnotationContext(annotation = currentAnnotation) {
    const cachedContext = extractSentenceFromBlockText(
      annotation?.contextBlockText,
      annotation?.rawText,
      annotation?.contextOffsetHint
    );

    if (cachedContext) {
      return cachedContext;
    }

    return extractContextAroundAnnotation(annotation);
  }

  function extractContextAroundAnnotation(annotation = currentAnnotation) {
    if (!annotation?.root.parentNode) {
      return "";
    }

    const parent = annotation.root.parentNode;
    const siblings = Array.from(parent.childNodes);
    const rootIndex = siblings.indexOf(annotation.root);
    const before = siblings
      .slice(Math.max(0, rootIndex - 2), rootIndex)
      .map((node) => getNodeText(node, annotation))
      .join("");
    const after = siblings
      .slice(rootIndex + 1, rootIndex + 3)
      .map((node) => getNodeText(node, annotation))
      .join("");

    return sanitizeText(`${before} ${annotation.rawText} ${after}`).slice(0, 240);
  }

  function setBusy(annotation, label) {
    if (!annotation?.root.isConnected) {
      return;
    }

    annotation.root.classList.add("is-loading");
    annotation.root.classList.remove("is-error");
    annotation.translationNode.textContent = label;
    annotation.saveButton.disabled = true;
    annotation.speakButton.disabled = true;
    annotation.refreshButton.disabled = true;
    annotation.clearButton.disabled = true;
    annotation.clearAllButton.disabled = true;
  }

  function setIdle(annotation) {
    if (!annotation?.root.isConnected) {
      return;
    }

    annotation.root.classList.remove("is-loading");
    annotation.saveButton.disabled = false;
    annotation.speakButton.disabled = false;
    annotation.refreshButton.disabled = false;
    annotation.clearButton.disabled = false;
    annotation.clearAllButton.disabled = false;
  }

  function updateAnnotationLayoutMode(annotation = currentAnnotation) {
    if (!annotation) {
      return;
    }

    const normalized = sanitizeText(annotation.rawText);
    const isSingleWord = Boolean(normalized) && !/\s/.test(normalized);
    annotation.root.classList.toggle("is-single-word", isSingleWord);
  }

  function getWordRangeFromPoint(x, y) {
    const caret = getCaretFromPoint(x, y);
    if (!caret || !caret.node) {
      return null;
    }

    const node = caret.node;
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent) {
      return null;
    }

    if (!isEligibleTextNode(node)) {
      return null;
    }

    const boundaries = findWordBoundaries(node.textContent, caret.offset);
    if (!boundaries) {
      return null;
    }

    const range = document.createRange();
    range.setStart(node, boundaries.start);
    range.setEnd(node, boundaries.end);

    if (!isPointInsideRange(range, x, y)) {
      return null;
    }

    return range;
  }

  function getCaretFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (!position) {
        return null;
      }

      return {
        node: position.offsetNode,
        offset: position.offset
      };
    }

    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (!range) {
        return null;
      }

      return {
        node: range.startContainer,
        offset: range.startOffset
      };
    }

    return null;
  }

  function findWordBoundaries(text, offset) {
    if (!text) {
      return null;
    }

    let index = Math.min(Math.max(offset, 0), text.length);

    if (!isWordCharacter(text[index]) && isWordCharacter(text[index - 1])) {
      index -= 1;
    }

    if (!isWordCharacter(text[index])) {
      return null;
    }

    let start = index;
    let end = index + 1;

    while (start > 0 && isWordCharacter(text[start - 1])) {
      start -= 1;
    }

    while (end < text.length && isWordCharacter(text[end])) {
      end += 1;
    }

    if (start === end) {
      return null;
    }

    return { start, end };
  }

  function isWordCharacter(char) {
    return typeof char === "string" && /[\p{L}\p{M}'’-]/u.test(char);
  }

  function isPointInsideRange(range, x, y) {
    const tolerance = 2;
    const rects = Array.from(range.getClientRects());

    return rects.some((rect) => {
      return (
        x >= rect.left - tolerance &&
        x <= rect.right + tolerance &&
        y >= rect.top - tolerance &&
        y <= rect.bottom + tolerance
      );
    });
  }

  function isEligibleTextNode(node) {
    const parent = node.parentElement;
    if (!parent) {
      return false;
    }

    if (isALangNode(parent) || isEditable(parent)) {
      return false;
    }

    return !parent.closest("script, style, noscript, iframe");
  }

  function isALangNode(node) {
    return node instanceof Element && Boolean(node.closest(INLINE_SELECTOR));
  }

  function findAnnotationFromNode(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    const root = element?.closest(INLINE_SELECTOR);
    if (!root) {
      return null;
    }

    for (const annotation of annotations) {
      if (annotation.root === root) {
        return annotation;
      }
    }

    return null;
  }

  function findAnnotationById(id) {
    if (!id) {
      return null;
    }

    for (const annotation of annotations) {
      if (annotation.id === id) {
        return annotation;
      }
    }

    return null;
  }

  function isSelectionRangeEligible(range, selectedText) {
    if (!LETTER_PATTERN.test(selectedText)) {
      return false;
    }

    const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

    if (!(container instanceof Element)) {
      return false;
    }

    if (isALangNode(container) || isEditable(container)) {
      return false;
    }

    if (container.closest("script, style, noscript, iframe, button, input, textarea, select, label, summary, audio, video, [role='button']")) {
      return false;
    }

    return true;
  }

  function getNormalizedSelectionRange(selection) {
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    snapRangeBoundariesToWords(range);
    return range;
  }

  function captureContextSnapshot(range, selectedText) {
    if (!range) {
      return null;
    }

    const container = findContextContainer(range.commonAncestorContainer);
    if (!container) {
      return null;
    }

    const blockRange = document.createRange();
    blockRange.selectNodeContents(container);

    const prefixRange = document.createRange();
    prefixRange.setStart(blockRange.startContainer, blockRange.startOffset);
    prefixRange.setEnd(range.startContainer, range.startOffset);

    const blockText = normalizeContextText(blockRange.toString());
    const prefixText = normalizeContextText(prefixRange.toString());
    const normalizedSelection = normalizeContextText(selectedText || range.toString());

    if (!blockText || !normalizedSelection) {
      return null;
    }

    const selectionStart = resolveSelectionOffsetHint(blockText, normalizedSelection, prefixText.length);
    return {
      blockText,
      selectionStart
    };
  }

  function findContextContainer(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!element) {
      return null;
    }

    return (
      element.closest("p, li, blockquote, figcaption, td, th, article, section, h1, h2, h3, h4, h5, h6") ||
      element.closest("main, article, section, div") ||
      document.body
    );
  }

  function resolveSelectionOffsetHint(blockText, selectedText, approximateStart) {
    if (!blockText || !selectedText) {
      return 0;
    }

    const positions = [];
    let searchFrom = 0;

    while (searchFrom < blockText.length) {
      const index = blockText.indexOf(selectedText, searchFrom);
      if (index === -1) {
        break;
      }

      positions.push(index);
      searchFrom = index + 1;
    }

    if (!positions.length) {
      return Math.max(0, Math.min(approximateStart, blockText.length));
    }

    return positions.reduce((best, current) => {
      return Math.abs(current - approximateStart) < Math.abs(best - approximateStart)
        ? current
        : best;
    }, positions[0]);
  }

  function extractSentenceFromBlockText(blockText, selectedText, approximateStart) {
    const normalizedBlock = normalizeContextText(blockText);
    const normalizedSelection = normalizeContextText(selectedText);

    if (!normalizedBlock || !normalizedSelection) {
      return "";
    }

    const selectionStart = resolveSelectionOffsetHint(
      normalizedBlock,
      normalizedSelection,
      typeof approximateStart === "number" ? approximateStart : 0
    );
    const selectionEnd = Math.min(
      normalizedBlock.length,
      selectionStart + normalizedSelection.length
    );

    const sentenceStart = findSentenceBoundaryBackward(normalizedBlock, selectionStart);
    const sentenceEnd = findSentenceBoundaryForward(normalizedBlock, selectionEnd);
    const sentence = normalizeContextText(normalizedBlock.slice(sentenceStart, sentenceEnd));

    if (sentence) {
      return sentence.slice(0, 320);
    }

    return normalizedBlock.slice(
      Math.max(0, selectionStart - 120),
      Math.min(normalizedBlock.length, selectionEnd + 120)
    );
  }

  function findSentenceBoundaryBackward(text, index) {
    for (let cursor = Math.max(0, index - 1); cursor >= 0; cursor -= 1) {
      if (/[.!?]/.test(text[cursor])) {
        return cursor + 1;
      }
    }

    return 0;
  }

  function findSentenceBoundaryForward(text, index) {
    for (let cursor = Math.max(0, index); cursor < text.length; cursor += 1) {
      if (/[.!?]/.test(text[cursor])) {
        return cursor + 1;
      }
    }

    return text.length;
  }

  function snapRangeBoundariesToWords(range) {
    if (!range || range.collapsed) {
      return;
    }

    const startBoundary = resolveWordBoundary(range.startContainer, range.startOffset, "start");
    if (startBoundary) {
      range.setStart(startBoundary.node, startBoundary.offset);
    }

    const endBoundary = resolveWordBoundary(range.endContainer, range.endOffset, "end");
    if (endBoundary) {
      range.setEnd(endBoundary.node, endBoundary.offset);
    }
  }

  function resolveWordBoundary(container, offset, edge) {
    if (container?.nodeType !== Node.TEXT_NODE || !container.textContent || !isEligibleTextNode(container)) {
      return null;
    }

    const text = container.textContent;
    const index = edge === "start"
      ? getWordIndexNearStart(text, offset)
      : getWordIndexNearEnd(text, offset);

    if (index < 0) {
      return null;
    }

    const boundaries = findWordBoundaries(text, index);
    if (!boundaries) {
      return null;
    }

    return {
      node: container,
      offset: edge === "start" ? boundaries.start : boundaries.end
    };
  }

  function getWordIndexNearStart(text, offset) {
    const safeOffset = Math.min(Math.max(offset, 0), text.length);

    if (isWordCharacter(text[safeOffset])) {
      return safeOffset;
    }

    if (safeOffset > 0 && isWordCharacter(text[safeOffset - 1])) {
      return safeOffset - 1;
    }

    return -1;
  }

  function getWordIndexNearEnd(text, offset) {
    const safeOffset = Math.min(Math.max(offset, 0), text.length);

    if (safeOffset > 0 && isWordCharacter(text[safeOffset - 1])) {
      return safeOffset - 1;
    }

    if (isWordCharacter(text[safeOffset])) {
      return safeOffset;
    }

    return -1;
  }

  function createTextFragment(text) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }

  function normalizeInlineFormatting() {
    if (pageWasNormalized) {
      return;
    }

    const candidates = Array.from(document.body.querySelectorAll(FLATTENABLE_INLINE_SELECTOR)).reverse();
    let changedAny = false;

    for (const element of candidates) {
      if (!canFlattenInlineElement(element)) {
        continue;
      }

      unwrapElement(element);
      changedAny = true;
    }

    pageWasNormalized = changedAny;
  }

  function canFlattenInlineElement(element) {
    if (!(element instanceof Element) || !element.isConnected) {
      return false;
    }

    if (isALangNode(element)) {
      return false;
    }

    if (element.closest("script, style, noscript, iframe, button, input, textarea, select, label, summary, audio, video, svg, math, canvas, picture")) {
      return false;
    }

    if (element.querySelector("img, svg, math, canvas, video, audio, iframe, button, input, textarea, select")) {
      return false;
    }

    const text = sanitizeText(element.textContent || "");
    if (!text) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display !== "inline") {
      return false;
    }

    return true;
  }

  function unwrapElement(element) {
    const parent = element.parentNode;
    if (!parent) {
      return;
    }

    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element);
    }

    parent.removeChild(element);
  }

  function fragmentNeedsComplexWrapper(fragment) {
    return Array.from(fragment.childNodes).some((node) => {
      return (
        node.nodeType === Node.ELEMENT_NODE ||
        (node.nodeType === Node.TEXT_NODE && /\s/.test(node.textContent || ""))
      );
    });
  }

  function isEditable(node) {
    return node instanceof Element && Boolean(node.closest("input, textarea, [contenteditable=''], [contenteditable='true']"));
  }

  function getNodeText(node, annotation = currentAnnotation) {
    if (node === annotation?.root) {
      return annotation.rawText;
    }

    return node.textContent || "";
  }

  function sanitizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeContextText(value) {
    return String(value || "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function getSpeechSettings() {
    if (!("speechSynthesis" in window)) {
      return {
        voice: null,
        lang: "en",
        rate: 0.9,
        pitch: 1
      };
    }

    let preferredName = "";
    let voiceSource = "any";
    let sourceLang = "en";
    let rate = 0.9;
    let pitch = 1;

    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      preferredName = sanitizeText(response?.settings?.speechVoiceName || "");
      voiceSource = sanitizeText(response?.settings?.speechVoiceSource || "any");
      sourceLang = sanitizeText(response?.settings?.sourceLang || "en");
      rate = clampSpeechNumber(response?.settings?.speechRate, 0.9, 0.65, 1.2);
      pitch = clampSpeechNumber(response?.settings?.speechPitch, 1, 0.8, 1.2);
    } catch (error) {
      preferredName = "";
      voiceSource = "any";
      sourceLang = "en";
    }

    const voices = await loadSpeechVoices();
    if (!voices.length) {
      return {
        voice: null,
        lang: getSpeechLanguageCode(sourceLang),
        rate,
        pitch
      };
    }

    if (preferredName) {
      const exactMatch = voices.find((voice) => voice.name === preferredName);
      if (exactMatch) {
        return {
          voice: exactMatch,
          lang: exactMatch.lang || getSpeechLanguageCode(sourceLang),
          rate,
          pitch
        };
      }
    }

    const voice = chooseNaturalVoice(voices, sourceLang, voiceSource);
    return {
      voice,
      lang: voice?.lang || getSpeechLanguageCode(sourceLang),
      rate,
      pitch
    };
  }

  async function getTranslationColor() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      return sanitizeText(response?.settings?.translationColor || DEFAULT_TRANSLATION_COLOR) ||
        DEFAULT_TRANSLATION_COLOR;
    } catch (error) {
      return DEFAULT_TRANSLATION_COLOR;
    }
  }

  async function getHighlightColor() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      return sanitizeText(response?.settings?.highlightColor || DEFAULT_HIGHLIGHT_COLOR) ||
        DEFAULT_HIGHLIGHT_COLOR;
    } catch (error) {
      return DEFAULT_HIGHLIGHT_COLOR;
    }
  }

  function applyAnnotationColors(root) {
    Promise.all([getTranslationColor(), getHighlightColor()]).then(([translationColor, highlightColor]) => {
      if (root?.isConnected) {
        root.style.setProperty("--alang-translation-color", translationColor);
        root.style.setProperty("--alang-highlight-color", resolveHighlightColor(highlightColor));
      }
    });
  }

  function applyTranslationColorToAnnotations(color) {
    const translationColor = sanitizeText(color || DEFAULT_TRANSLATION_COLOR) || DEFAULT_TRANSLATION_COLOR;

    for (const annotation of annotations) {
      if (annotation.root?.isConnected) {
        annotation.root.style.setProperty("--alang-translation-color", translationColor);
      }
    }
  }

  function applyHighlightColorToAnnotations(color) {
    const highlightColor = resolveHighlightColor(color);

    for (const annotation of annotations) {
      if (annotation.root?.isConnected) {
        annotation.root.style.setProperty("--alang-highlight-color", highlightColor);
      }
    }
  }

  function resolveHighlightColor(color) {
    const normalized = sanitizeText(color || DEFAULT_HIGHLIGHT_COLOR).toLowerCase();
    return HIGHLIGHT_COLOR_VALUES[normalized] || HIGHLIGHT_COLOR_VALUES[DEFAULT_HIGHLIGHT_COLOR];
  }

  function chooseNaturalVoice(voices, sourceLang = "en", voiceSource = "any") {
    const languagePrefix = getSpeechLanguagePrefix(sourceLang);
    const matchingVoices = voices.filter((voice) => {
      return String(voice.lang || "").toLowerCase().startsWith(languagePrefix);
    });
    if (!matchingVoices.length) {
      return null;
    }

    const localVoices = matchingVoices.filter((voice) => voice.localService);
    const candidates = voiceSource === "system" && localVoices.length
      ? localVoices
      : matchingVoices;

    return candidates
      .slice()
      .sort((left, right) => {
        return scoreSpeechVoice(right, sourceLang, voiceSource) -
          scoreSpeechVoice(left, sourceLang, voiceSource);
      })[0];
  }

  function scoreSpeechVoice(voice, sourceLang = "en", voiceSource = "any") {
    const name = `${voice.name || ""} ${voice.voiceURI || ""}`.toLowerCase();
    const lang = String(voice.lang || "").toLowerCase();
    const preferredSpeechLang = getSpeechLanguageCode(sourceLang).toLowerCase();
    const languagePrefix = getSpeechLanguagePrefix(sourceLang);
    let score = 0;

    if (lang === preferredSpeechLang) {
      score += 30;
    } else if (lang.startsWith(`${languagePrefix}-`) || lang === languagePrefix) {
      score += 18;
    }

    if (voice.localService) {
      score += voiceSource === "system" ? 40 : 8;
    } else if (voiceSource !== "system") {
      score += 12;
    }

    const preferredNames = [
      "samantha",
      "ava",
      "allison",
      "nicky",
      "victoria",
      "karen",
      "serena",
      "jenny",
      "aria",
      "guy",
      "ryan",
      "google us english",
      "google uk english female"
    ];

    for (let index = 0; index < preferredNames.length; index += 1) {
      if (name.includes(preferredNames[index])) {
        score += 80 - index;
        break;
      }
    }

    if (name.includes("enhanced") || name.includes("premium") || name.includes("natural")) {
      score += 20;
    }

    if (name.includes("compact") || name.includes("default") || name.includes("espeak")) {
      score -= 30;
    }

    return score;
  }

  function getSpeechLanguagePrefix(sourceLang) {
    return sourceLang === "zh-CN" ? "zh" : String(sourceLang || "en").toLowerCase();
  }

  function getSpeechLanguageCode(sourceLang) {
    if (sourceLang === "zh-CN") {
      return "zh-CN";
    }

    return String(sourceLang || "en");
  }

  function clampSpeechNumber(value, fallback, min, max) {
    const number = Number.parseFloat(String(value || "").replace(",", "."));
    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, number));
  }

  function loadSpeechVoices() {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        resolve([]);
        return;
      }

      const existingVoices = window.speechSynthesis.getVoices();
      if (existingVoices.length) {
        resolve(existingVoices);
        return;
      }

      const handleVoicesChanged = () => {
        window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
        resolve(window.speechSynthesis.getVoices());
      };

      window.speechSynthesis.addEventListener("voiceschanged", handleVoicesChanged, { once: true });
      window.setTimeout(() => {
        window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
        resolve(window.speechSynthesis.getVoices());
      }, 600);
    });
  }
})();
