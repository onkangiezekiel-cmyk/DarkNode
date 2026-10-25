import { CheckCircle2 } from 'lucide-react'
import Modal from './Modal'

export default function SuccessModal({ title, message, onClose }: {
  title: string
  message: string
  onClose: () => void
}) {
  return (
    <Modal title={title} onClose={onClose} className="success-modal">
      <div className="success-modal-content" role="status">
        <span className="success-modal-icon"><CheckCircle2 size={30} aria-hidden="true" /></span>
        <p>{message}</p>
        <button className="primary-button full-button" type="button" onClick={onClose}>Done</button>
      </div>
    </Modal>
  )
}
