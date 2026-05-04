import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '../../tests/helpers/render';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../../tests/helpers/msw/server';
import { resetAllStores, seedStore } from '../../tests/helpers/store';
import { buildUser, buildTrip, buildTripFile } from '../../tests/helpers/factories';
import { useAuthStore } from '../store/authStore';
import { useTripStore } from '../store/tripStore';
import FilesPage from './FilesPage';
import { offlineDb } from '../db/offlineDb';

vi.mock('../components/Files/FileManager', () => ({
  default: ({ files }: { files: unknown[]; onUpload: unknown; onDelete: unknown }) =>
    React.createElement('div', { 'data-testid': 'file-manager' }, `${files.length} files`),
}));

vi.mock('../components/Layout/Navbar', () => ({
  default: ({ tripTitle }: { tripTitle?: string }) =>
    React.createElement('nav', { 'data-testid': 'navbar' }, tripTitle),
}));

function renderFilesPage(tripId: number | string = 1) {
  return render(
    <Routes>
      <Route path="/trips/:id/files" element={<FilesPage />} />
    </Routes>,
    { initialEntries: [`/trips/${tripId}/files`] },
  );
}

beforeEach(async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await Promise.all(offlineDb.tables.map(t => t.clear()));
  vi.clearAllMocks();
  resetAllStores();
  seedStore(useAuthStore, { isAuthenticated: true, user: buildUser() });
  seedStore(useTripStore, {
    files: [],
    loadFiles: vi.fn().mockResolvedValue(undefined),
    addFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  } as any);
});

describe('FilesPage', () => {
  describe('FE-PAGE-FILES-001: Loading spinner shown while data fetches', () => {
    it('shows a spinner while data is loading', async () => {
      server.use(
        http.get('/api/trips/:id', async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          const trip = buildTrip({ id: 1 });
          return HttpResponse.json({ trip });
        }),
      );

      renderFilesPage(1);

      expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-FILES-002: Trip name displayed in Navbar after load', () => {
    it('passes the trip name to Navbar after data loads', async () => {
      const trip = buildTrip({ id: 1, name: 'Rome Trip' });
      server.use(
        http.get('/api/trips/:id', () => HttpResponse.json({ trip })),
      );

      renderFilesPage(1);

      await waitFor(() => {
        expect(screen.getByTestId('navbar')).toHaveTextContent('Rome Trip');
      });
    });
  });

  describe('FE-PAGE-FILES-003: FileManager renders after load', () => {
    it('renders the FileManager after data loads', async () => {
      renderFilesPage(1);

      await waitFor(() => {
        expect(screen.getByTestId('file-manager')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-FILES-004: File count shown in header', () => {
    it('shows the correct file count in the header', async () => {
      const file1 = buildTripFile();
      const file2 = buildTripFile();
      seedStore(useTripStore, {
        files: [file1, file2],
        loadFiles: vi.fn().mockResolvedValue(undefined),
        addFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      } as any);

      renderFilesPage(1);

      await waitFor(() => {
        expect(screen.getByTestId('file-manager')).toBeInTheDocument();
      });

      expect(screen.getByText(/2 files for/i)).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-FILES-005: Back link navigates to trip planner', () => {
    it('back link points to the trip planner page', async () => {
      renderFilesPage(1);

      await waitFor(() => {
        expect(screen.getByTestId('file-manager')).toBeInTheDocument();
      });

      const backLink = screen.getByRole('link', { name: /back to planning/i });
      expect(backLink.getAttribute('href')).toContain('/trips/1');
    });
  });

  describe('FE-PAGE-FILES-006: loadFiles is called with trip ID on mount', () => {
    it('calls tripStore.loadFiles with the trip ID from the URL', async () => {
      const mockLoadFiles = vi.fn().mockResolvedValue(undefined);
      seedStore(useTripStore, {
        files: [],
        loadFiles: mockLoadFiles,
        addFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      } as any);

      renderFilesPage(1);

      await waitFor(() => {
        expect(mockLoadFiles).toHaveBeenCalledWith('1');
      });
    });
  });

  describe('FE-PAGE-FILES-007: Navigation to /dashboard on fetch error', () => {
    it('navigates to /dashboard when trip fetch fails', async () => {
      server.use(
        http.get('/api/trips/:id', () =>
          HttpResponse.json({ error: 'Not found' }, { status: 404 }),
        ),
      );

      render(
        <Routes>
          <Route path="/trips/:id/files" element={<FilesPage />} />
          <Route path="/dashboard" element={<div data-testid="dashboard">Dashboard</div>} />
        </Routes>,
        { initialEntries: ['/trips/1/files'] },
      );

      await waitFor(() => {
        expect(screen.getByTestId('dashboard')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-FILES-008: Files update when tripStore.files changes', () => {
    it('FileManager re-renders when store files change', async () => {
      seedStore(useTripStore, {
        files: [],
        loadFiles: vi.fn().mockResolvedValue(undefined),
        addFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      } as any);

      renderFilesPage(1);

      await waitFor(() => {
        expect(screen.getByTestId('file-manager')).toBeInTheDocument();
      });

      expect(screen.getByTestId('file-manager')).toHaveTextContent('0 files');

      // Simulate store update
      act(() => {
        useTripStore.setState({ files: [buildTripFile({ id: 99, original_name: 'document.pdf' })] } as any);
      });

      await waitFor(() => {
        expect(screen.getByTestId('file-manager')).toHaveTextContent('1 files');
      });
    });
  });

  describe('FE-PAGE-FILES-009: Empty file list renders FileManager with 0 files', () => {
    it('renders FileManager with 0 files when files array is empty', async () => {
      renderFilesPage(1);

      await waitFor(() => {
        expect(screen.getByTestId('file-manager')).toBeInTheDocument();
      });

      expect(screen.getByTestId('file-manager')).toHaveTextContent('0 files');
    });
  });

  describe('FE-PAGE-FILES-010: Page title heading present', () => {
    it('renders the "Dateien & Dokumente" heading', async () => {
      renderFilesPage(1);

      await waitFor(() => {
        expect(screen.getByTestId('file-manager')).toBeInTheDocument();
      });

      expect(screen.getByRole('heading', { name: /Files & Documents/i })).toBeInTheDocument();
    });
  });
});
