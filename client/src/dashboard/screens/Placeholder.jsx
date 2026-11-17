import { useT } from '../lib/i18n.js';
import { Empty, Button } from '../ui/kit.jsx';
import { navigate } from '../lib/router.jsx';

// Shown for a route whose screen hasn't been built yet in this phase.
export default function Placeholder({ path }) {
  const t = useT();
  return (
    <div style={{ paddingTop: 60 }}>
      <Empty icon="sparkle" title={t('state.comingSoon')} actions={<Button onClick={() => navigate('/')}>{t('nav.overview')}</Button>}>
        <code>{`/app${path}`}</code>
      </Empty>
    </div>
  );
}
