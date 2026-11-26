import type { ReactNode } from 'react';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@ui-sdk/react/dialog';
import styles from './dialog.module.css';

export default function DialogIsland({ label, body }: { readonly label: string; readonly body: ReactNode }) {
  return (
    <Dialog modal={true}>
      <DialogTrigger>{label}</DialogTrigger>
      <DialogContent className={styles.content}>
        <DialogTitle>{label}</DialogTitle>
        {body}
        <DialogClose>Close</DialogClose>
      </DialogContent>
    </Dialog>
  );
}
