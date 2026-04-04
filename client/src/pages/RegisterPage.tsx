import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useTranslation } from '../i18n'
import { Map, Eye, EyeOff, Mail, Lock, User } from 'lucide-react'

export default function RegisterPage(): React.ReactElement {
  const { t } = useTranslation()
  const [username, setUsername] = useState<string>('')
  const [email, setEmail] = useState<string>('')
  const [password, setPassword] = useState<string>('')
  const [confirmPassword, setConfirmPassword] = useState<string>('')
  const [showPassword, setShowPassword] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string>('')

  const { register } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError(t('register.passwordMismatch'))
      return
    }

    if (password.length < 8) {
      setError(t('register.passwordTooShort'))
      return
    }

    setIsLoading(true)
    try {
      await register(username, email, password)
      navigate('/dashboard')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('register.failed'))
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left panel */}
      <div className="hidden lg:flex lg:w-1/2 bg-slate-900 flex-col justify-center items-center p-12 text-white">
        <div className="max-w-sm text-center">
          <div className="w-20 h-20 bg-white/10 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Map className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-4xl font-bold mb-4">{t('register.getStarted')}</h1>
          <p className="text-slate-300 text-lg leading-relaxed">
            {t('register.subtitle')}
          </p>

          <div className="mt-10 space-y-3 text-left">
            {[
              `✓ ${t('register.feature1')}`,
              `✓ ${t('register.feature2')}`,
              `✓ ${t('register.feature3')}`,
              `✓ ${t('register.feature4')}`,
              `✓ ${t('register.feature5')}`,
              `✓ ${t('register.feature6')}`,
            ].map(item => (
              <p key={item} className="text-slate-200 text-sm">{item}</p>
            ))}
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center p-8 bg-slate-50">
        <div className="w-full max-w-md">
          <div className="lg:hidden flex items-center gap-2 mb-8 justify-center">
            <Map className="w-8 h-8 text-slate-900" />
            <span className="text-2xl font-bold text-slate-900">TREK</span>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
            <h2 className="text-2xl font-bold text-slate-900 mb-1">{t('register.createAccount')}</h2>
            <p className="text-slate-500 mb-8">{t('register.startPlanning')}</p>

            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.username')}</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="text"
                    value={username}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUsername(e.target.value)}
                    required
                    placeholder="johndoe"
                    minLength={3}
                    className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-slate-400 focus:border-transparent transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('common.email')}</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                    required
                    placeholder="your@email.com"
                    className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-slate-400 focus:border-transparent transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('common.password')}</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                    required
                    placeholder={t('register.minChars')}
                    className="w-full pl-10 pr-12 py-2.5 border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-slate-400 focus:border-transparent transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('register.confirmPassword')}</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPassword(e.target.value)}
                    required
                    placeholder={t('register.repeatPassword')}
                    className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-slate-400 focus:border-transparent transition-all"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-700 disabled:bg-slate-400 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    {t('register.registering')}
                  </>
                ) : t('register.register')}
              </button>
            </form>

            <div className="mt-6 text-center">
              <p className="text-sm text-slate-500">
                {t('register.hasAccount')}{' '}
                <Link to="/login" className="text-slate-900 hover:text-slate-700 font-medium">
                  {t('register.signIn')}
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
