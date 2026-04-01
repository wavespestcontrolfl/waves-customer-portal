import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../utils/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Check for existing session on mount
  useEffect(() => {
    const token = localStorage.getItem('waves_token');
    if (token) {
      api.token = token;
      api.refreshToken = localStorage.getItem('waves_refresh_token');
      loadCustomer();
    } else {
      setLoading(false);
    }
  }, []);

  const loadCustomer = useCallback(async () => {
    try {
      const data = await api.getMe();
      setCustomer(data);
      setError(null);
    } catch (err) {
      console.error('Failed to load customer:', err);
      api.clearTokens();
      setCustomer(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const sendCode = async (phone) => {
    setError(null);
    try {
      await api.sendCode(phone);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  const verifyCode = async (phone, code) => {
    setError(null);
    try {
      const data = await api.verifyCode(phone, code);
      api.setTokens(data.token, data.refreshToken);
      await loadCustomer();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  const logout = () => {
    api.clearTokens();
    setCustomer(null);
  };

  return (
    <AuthContext.Provider value={{
      customer,
      loading,
      error,
      isAuthenticated: !!customer,
      sendCode,
      verifyCode,
      logout,
      refreshCustomer: loadCustomer,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
