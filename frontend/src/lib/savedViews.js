import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatApiErrorDetail } from "./api";
import { useAuth } from "./auth";

export function useSavedView(page, defaultState, normalize = (state) => state) {
  const { user } = useAuth();
  const userKey = user?.id || "";
  const [state, setState] = useState(defaultState);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const stateRef = useRef(defaultState);
  const defaultStateRef = useRef(defaultState);
  const loaded = useRef(false);
  const normalizeRef = useRef(normalize);
  const saveTimer = useRef(null);
  const changedBeforeLoad = useRef(false);
  const dirty = useRef(false);
  const saving = useRef(false);
  const mounted = useRef(false);
  const retryCount = useRef(0);
  const retryExhausted = useRef(false);
  const ownerRef = useRef(userKey);
  normalizeRef.current = normalize;
  defaultStateRef.current = defaultState;

  const flushSave = useCallback(() => {
    if (saving.current || !dirty.current) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const stateToSave = stateRef.current;
    dirty.current = false;
    saving.current = true;
    Promise.resolve(api.put?.(`/views/${page}`, { state: stateToSave }))
      .then(() => {
        retryCount.current = 0;
        retryExhausted.current = false;
        if (mounted.current) setError("");
      })
      .catch((requestError) => {
        if (!dirty.current && stateRef.current === stateToSave) dirty.current = true;
        if (mounted.current) setError(`View changes were not saved: ${formatApiErrorDetail(requestError.response?.data?.detail)}`);
        retryCount.current += 1;
        if (mounted.current && retryCount.current <= 2) {
          saveTimer.current = setTimeout(flushSave, retryCount.current * 1000);
        } else if (retryCount.current > 2) {
          retryExhausted.current = true;
        }
      })
      .finally(() => {
        saving.current = false;
        if (mounted.current && dirty.current && !saveTimer.current && !retryExhausted.current) {
          saveTimer.current = setTimeout(flushSave, 0);
        }
      });
  }, [page]);

  const queueSave = useCallback((delay = 250) => {
    dirty.current = true;
    retryCount.current = 0;
    retryExhausted.current = false;
    if (saving.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, delay);
  }, [flushSave]);

  const loadView = useCallback(() => {
    let active = true;
    const owner = userKey;
    loaded.current = false;
    changedBeforeLoad.current = false;
    if (mounted.current) setLoading(true);
    Promise.resolve(api.get(`/views/${page}`))
      .then((response) => {
        if (!active || ownerRef.current !== owner || !response?.data?.state) return;
        if (changedBeforeLoad.current) return;
        const next = normalizeRef.current(response.data.state);
        stateRef.current = next;
        setState(next);
      })
      .catch((requestError) => {
        if (active && ownerRef.current === owner) setError(`Saved view unavailable: ${formatApiErrorDetail(requestError.response?.data?.detail)}`);
      })
      .finally(() => {
        if (!active || ownerRef.current !== owner) return;
        loaded.current = true;
        setLoading(false);
        if (changedBeforeLoad.current) queueSave(0);
      });
    return () => { active = false; };
  }, [page, queueSave, userKey]);

  useEffect(() => {
    mounted.current = true;
    if (ownerRef.current !== userKey) {
      ownerRef.current = userKey;
      dirty.current = false;
      stateRef.current = defaultStateRef.current;
      setState(defaultStateRef.current);
      setError("");
    }
    const cleanupLoad = loadView();
    return () => {
      cleanupLoad?.();
      mounted.current = false;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (dirty.current && !saving.current) flushSave();
    };
  }, [loadView, flushSave, userKey]);

  const updateState = useCallback((nextState) => {
    const next = typeof nextState === "function" ? nextState(stateRef.current) : nextState;
    stateRef.current = next;
    setState(next);
    if (loaded.current) {
      queueSave();
    } else {
      changedBeforeLoad.current = true;
      dirty.current = true;
    }
  }, [queueSave]);

  return { state, updateState, error, clearError: () => setError(""), loading, retry: loadView };
}